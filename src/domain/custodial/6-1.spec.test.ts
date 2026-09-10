// 6.1 Establish P&I custodial account (Form 1013)
// spec/sections/06-custodial-account-management/6-1-establish-p-i-custodial-account-form-1013.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { defaultCalendars, servicerCalendar } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, SYSTEM, eventMatches, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import type { CalendarSet } from "../../kernel/calendar/business.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import type { CommandContext } from "../../app/commands.ts";
import { TOOLS_6_1 } from "../../app/tools/section6-1.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { loadAgentsFile } from "../../app/agents.ts";
import { NoticeRegistry } from "../../notices/registry.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { publishSection06 } from "../../notices/authored/section06.ts";
import { proposeBatch } from "../transfers/inbound.ts";
import { evaluateDepositoryEligibility, accountPlan, depositGate, ineligibilityNoticeDueMs, lockboxCustodialDeadline, formMachine, titleString } from "./accounts.ts";
import { ET, verifyExecutedForm, ineligibilityNoticeOutcome, ineligibleDepositoryPackage, postingSetBalanced } from "./ops.ts";
import { planCustodialAccounts, prepareCbamPackage, sendFormForSignature, ingestCbamFormStatus, markFormInEffect, activateAccount, checkDepositoryRatings, ingestLockboxBatch, confirmCustodialDeposit, initiateDeposit, DepositGateClosed, ingestClearingCredit, sweepClearingToCustodial, clearingSweep, servicingFeeCents, custodialEvidenceFacts, custodialEvidenceDueOn, recordBankAccountOpened, ACCOUNT_AGG, DEPOSITORY_AGG, LOCKBOX_BATCH_AGG, CLEARING_CREDIT_AGG, FNMA_CUSTODIAL_TEAM, type CbamPackage } from "./ops-6-1.ts";

const at = (d: string, t: string) => toIso(zonedEpochMs(D(d), t, ET));
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const OPERATOR: Actor = { kind: "human", id: "u-portal", role: "fnma_portal_operator" };
const DOCUSIGN: Actor = { kind: "external", id: "docusign" };
const AGENT: Actor = { kind: "agent", id: "custodial-recon" };
const REG = loadOverriddenRegistry();   // loaded once: the engines never mutate it
function engine(nowIso: string, processes: string[], calendars?: CalendarSet) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(REG, events, { processes, ...(calendars ? { calendars } : {}) });
  return { clock, events, timers, escalations: new EscalationService(events, clock), registry: REG };
}
const PORTFOLIO = [{ remittance_type: "A/A", pool_class: "portfolio_mrs" }, { remittance_type: "S/A", pool_class: "portfolio_mrs" }, { remittance_type: "S/S", pool_class: "mbs" }, { remittance_type: "S/S", pool_class: "portfolio_mrs" }, { remittance_type: "A/A", pool_class: "mbs" }] as const;
const ARRANGEMENT = { arrangement_id: "ARR-1", servicer_name: "Supermortgage LLC", master_servicer_name: "Partner Bank N.A.", master_servicer_numbers: ["123456789"], subservicer_number: "987654321", portfolio: [...PORTFOLIO], depository_id: "DEP-X" };
const PI_TITLE = "Supermortgage LLC as subservicer for Partner Bank N.A., as agent, trustee, and/or bailee for the benefit of Fannie Mae and/or payments of various mortgagors and/or various owners of interests in mortgage-backed securities (Custodial Account)";
const SS_MBS = "ARR-1:PI:SS:MBS";
const PLAN_FACTS = { account_number: "123456789", title: PI_TITLE, aba: "021000021", remittance_type: "S/S", effective_date: D("2026-11-01") };
const PACKAGE: CbamPackage = { form_id: "F-1013-1", custodial_account_id: SS_MBS, form_kind: "1013", master_servicer_numbers: ["123456789"], subservicer_number: "987654321", depository: { aba: "021000021", branch_name: "Depository X — Main", physical_address: "1 Bank Plaza, New York, NY 10004" }, account_number: "123456789", remittance_type: "S/S", interest_bearing: true, effective_date: D("2026-11-01"), servicer_rep: { user_id: "u-officer", role: "officer" }, depository_rep: { name: "D. Rep", title: "VP", email: "drep@depositoryx.com" }, title: PI_TITLE };
/** A minimal bus context for calling a 6.1 tool handler directly (the bus test exercises them through CommandBus). */
function toolCtx(e: ReturnType<typeof engine>, actor: Actor): { ctx: CommandContext; rt: ToolRuntime } {
  const ctx = { events: e.events, timers: e.timers, clock: e.clock, actor, now: e.clock.now(), loanId: "", ledger: {} as CommandContext["ledger"], decide: () => undefined } as unknown as CommandContext;
  return { ctx, rt: { store: new EntityStore(), ports: {}, escalations: e.escalations, services: {} } };
}
const tool = (name: string) => { const t = TOOLS_6_1.find((x) => x.name === name); if (!t) throw new Error(`no 6.1 tool ${name}`); return t; };

test("6.1-T1: Given a portfolio with A/A, S/A and S/S (MBS + MRS) loans, when the plan is built, then four P&I accounts + one T&I are planned, exactly one drafting account per remittance type, S/S split by pool class.", () => {
  const plan = accountPlan([...PORTFOLIO]);
  assert.equal(plan.filter((p) => p.kind === "pi").length, 4); assert.equal(plan.filter((p) => p.kind === "ti").length, 1);
  const e = engine("2026-10-01T14:00:00.000Z", ["6.1"]);
  const r = planCustodialAccounts(e.events, ARRANGEMENT);
  const pi = r.accounts.filter((a) => a.kind === "pi");
  assert.equal(pi.length, 4); assert.equal(r.accounts.filter((a) => a.kind === "ti").length, 1); assert.equal(r.accounts.filter((a) => a.kind === "clearing").length, 1, "decision 2 default: one titled clearing account");
  for (const t of ["A/A", "S/A", "S/S"] as const) assert.equal(pi.filter((p) => p.remittance_type === t && p.is_drafting_account).length, 1, `one drafting account for ${t}`);
  assert.deepEqual(pi.filter((p) => p.remittance_type === "S/S").map((p) => p.pool_class).sort(), ["mbs", "portfolio_mrs"]);
  assert.ok(pi.filter((p) => p.remittance_type === "A/A").every((p) => p.pool_class === "na"), "A/A is not split by pool class");
  assert.deepEqual(pi.map((p) => p.account_id), ["ARR-1:PI:AA", "ARR-1:PI:SA", SS_MBS, "ARR-1:PI:SS:PORTFOLIO_MRS"]);
  // F-1-03 verbatim titles, with the job aid's subservicer naming
  assert.equal(pi[0]!.title, PI_TITLE); assert.equal(titleString("Supermortgage LLC", "pi", "Partner Bank N.A."), PI_TITLE);
  assert.equal(r.accounts.find((a) => a.kind === "ti")!.title, "Supermortgage LLC as subservicer for Partner Bank N.A., as agent and/or trustee for the benefit of Fannie Mae and payments of various mortgagors, respectively (Custodial Account)");
  // ledger rows per the data model
  assert.deepEqual(pi.find((p) => p.account_id === SS_MBS)!.ledger_accounts, [`custodial_pi_cash:${SS_MBS}`, "fnma_remittance_payable:S/S:mbs", "servicer_advance_receivable"]);
  // `custodial.account.planned{kind}` per account; the Form 1013 gate arms once per P&I account (not for T&I or clearing) and has no due date
  const planned = e.events.ofType("custodial.account.planned"); assert.equal(planned.length, 6); assert.deepEqual(planned.map((x) => x.payload["kind"]), ["pi", "pi", "pi", "pi", "ti", "clearing"]);
  const gates = e.timers.byCode("FNMA_F103_FORM1013_IN_EFFECT_GATE");
  assert.deepEqual(gates.map((g) => g.subject.id).sort(), pi.map((p) => p.account_id).sort()); assert.ok(gates.every((g) => g.status === "armed" && g.dueAt === undefined));
  assert.throws(() => planCustodialAccounts(e.events, { ...ARRANGEMENT, portfolio: [] }), RangeError);
  assert.throws(() => planCustodialAccounts(e.events, { ...ARRANGEMENT, master_servicer_numbers: ["12345"] }), /9-digit/);
});
test("6.1-T2: Given a $12B bank with IDC 120 and KBRA C, when evaluated for S/S use, then ineligible; for A/A-only use, then eligible; decision record lists the rule applied.", () => {
  const bank = { name: "X", insured: true, well_capitalized: true, total_assets_cents: 1_200_000_000_000n, ratings: { idc: 120, kbra: "C" } };
  const ss = evaluateDepositoryEligibility(bank, "S/S"); assert.equal(ss.eligible, false); assert.match(ss.rule, /S\/S: IDC≥125 ∨ KBRA≥C\+/);
  const aa = evaluateDepositoryEligibility(bank, "A/A"); assert.equal(aa.eligible, true); assert.equal(aa.rule, "<$30B A/A,S/A only: IDC≥75 ∨ KBRA≥C");
  assert.equal(evaluateDepositoryEligibility({ ...bank, insured: false }, "A/A").rule, "insured ∧ well_capitalized");
  // the `depository.evaluate` tool returns the decision record with the rule applied
  const e = engine("2026-10-15T14:00:00.000Z", ["6.1"]); const { ctx, rt } = toolCtx(e, AGENT);
  const d = tool("depository.evaluate").handler({ depository: bank, account_use: "S/S" }, ctx, rt) as { eligible: boolean; decision: { rule_applied: string; rule_set: string } };
  assert.equal(d.eligible, false); assert.match(d.decision.rule_applied, /IDC≥125/); assert.equal(d.decision.rule_set, "rule_sets.fnma.custodial.2023-07");
  // the rating monitor evaluates each account for its own use and records the rule on `custodial.depository.rating_checked`
  const r = checkDepositoryRatings(e.events, { depository: { ...bank, id: "DEP-X" }, ratings_as_of: D("2026-10-15"), checked_on: D("2026-10-15"), accounts: [{ account_id: SS_MBS, use: "S/S" }, { account_id: "ARR-1:PI:AA", use: "A/A" }], fdic_as_of: D("2026-10-01") });
  assert.equal(r.eligibility_status, "ineligible"); assert.deepEqual(r.results.map((x) => x.eligible), [false, true]);
  const checked = e.events.ofType("custodial.depository.rating_checked"); assert.equal(checked.length, 2);
  assert.match(String(checked[0]!.payload["rule"]), /S\/S: IDC≥125/); assert.equal(checked[1]!.payload["rule"], "<$30B A/A,S/A only: IDC≥75 ∨ KBRA≥C");
  assert.deepEqual(r.ineligible_detected!.payload["failing_accounts"], [SS_MBS]); assert.equal(r.ineligible_detected!.payload["floor"], 125);
  assert.throws(() => tool("depository.evaluate").handler({}, ctx, rt), RangeError);
});
test("6.1-T3: Given a $40B bank with S&P ST A-3 and no Moody's, when evaluated, then eligible under the ≥ $30B test.", () => {
  const big = { name: "Y", insured: true, well_capitalized: true, total_assets_cents: 4_000_000_000_000n, ratings: { sp_st: "A-3" } };
  const r = evaluateDepositoryEligibility(big, "S/S");
  assert.equal(r.eligible, true); assert.match(r.rule, /^≥\$30B/);
  assert.equal(evaluateDepositoryEligibility({ ...big, ratings: { sp_st: "B" } }, "S/S").eligible, false);
  const e = engine("2026-10-15T14:00:00.000Z", ["6.1"]);
  const c = checkDepositoryRatings(e.events, { depository: { ...big, id: "DEP-Y" }, ratings_as_of: D("2026-10-15"), checked_on: D("2026-10-15"), accounts: [{ account_id: SS_MBS, use: "S/S" }], fdic_as_of: D("2026-09-20") });
  assert.equal(c.eligibility_status, "eligible"); assert.equal(c.ineligible_detected, null); assert.equal(e.events.ofType("custodial.depository.ineligible_detected").length, 0);
  // edge "Vendor outage": FDIC evidence older than 35 days → unknown, no ineligibility notice, and the account cannot be activated on it
  const u = checkDepositoryRatings(e.events, { depository: { ...big, id: "DEP-Y" }, ratings_as_of: D("2026-10-15"), checked_on: D("2026-10-15"), accounts: [{ account_id: SS_MBS, use: "S/S" }], fdic_as_of: D("2026-09-01") });
  assert.equal(u.eligibility_status, "unknown"); assert.equal(u.results[0]!.eligible, false); assert.match(u.results[0]!.rule, /older than 35 days/);
});
test("6.1-T4: Given a form in `pending_signatures`, when a deposit command targets the account, then the gate rejects it with `FNMA_F103_FORM1013_IN_EFFECT_GATE`.", () => {
  const g = depositGate({ status: "pending_signatures", kind: "1013" });
  assert.equal(g.ok, false); if (!g.ok) { assert.equal(g.gate, "FNMA_F103_FORM1013_IN_EFFECT_GATE"); assert.equal(g.reason, "form status pending_signatures"); assert.equal(g.task?.action, "cbam_form_signature"); }
  assert.equal(depositGate({ status: "in_effect", kind: "1013" }).ok, true);
  const e = engine("2026-10-01T14:00:00.000Z", ["6.1"]);
  planCustodialAccounts(e.events, ARRANGEMENT);
  const gate = e.timers.byCode("FNMA_F103_FORM1013_IN_EFFECT_GATE").find((t) => t.subject.id === SS_MBS)!;
  const pkg = prepareCbamPackage(e.events, e.escalations, PACKAGE);
  sendFormForSignature(e.events, e.escalations, { form_id: "F-1013-1", custodial_account_id: SS_MBS, form_kind: "1013", status: "in_draft", cbam_form_number: "CBAM-1013-0001", sent_at: D("2026-10-01"), portal_task_id: pkg.portal_task_id }, OPERATOR);
  const deposit = { deposit_id: "DEP-1", account_id: SS_MBS, form: { status: "pending_signatures" as const, kind: "1013" as const }, amount_cents: 135_412n, source: "wire" as const, deposited_on: D("2026-10-02") };
  assert.throws(() => initiateDeposit(e.events, e.timers, deposit), (err: unknown) => err instanceof DepositGateClosed && err.gate === "FNMA_F103_FORM1013_IN_EFFECT_GATE" && /pending_signatures/.test(err.message) && err.task?.action === "cbam_form_signature");
  assert.equal(e.events.ofType("custodial.deposit.initiated").length, 0); assert.equal(gate.status, "armed");
  // even if a caller asserts in_effect facts, the armed gate instance is the source of truth
  assert.throws(() => initiateDeposit(e.events, e.timers, { ...deposit, form: { status: "in_effect", kind: "1013" } }), (err: unknown) => err instanceof DepositGateClosed && /still armed/.test(err.message));
  // fully signed, executed PDF verified → in_effect opens the gate and the deposit goes through
  ingestCbamFormStatus(e.events, e.escalations, e.timers, { form_id: "F-1013-1", custodial_account_id: SS_MBS, form_kind: "1013", status: "pending_signatures", cbam_status: "Fully Signed", cbam_form_number: "CBAM-1013-0001", servicer_signed_at: "2026-10-02T15:00:00.000Z", depository_signed_at: "2026-10-05T15:00:00.000Z" }, DOCUSIGN);
  const v = markFormInEffect(e.events, e.escalations, { form_id: "F-1013-1", custodial_account_id: SS_MBS, form_kind: "1013", status: "fully_signed", plan: PLAN_FACTS, executed: PLAN_FACTS, executed_document_hash: "sha256:9f2c", as_of: D("2026-11-01") });
  assert.equal(v.in_effect, true); assert.equal(gate.status, "satisfied"); assert.equal(gate.satisfiedByEventId, v.event!.id);
  assert.ok(eventMatches(e.registry.get("FNMA_F103_FORM1013_IN_EFFECT_GATE")!.satisfiedPattern!, v.event!));
  const ok = initiateDeposit(e.events, e.timers, { ...deposit, form: { status: "in_effect", kind: "1013" }, deposited_on: D("2026-11-02") });
  assert.equal(ok.type, "custodial.deposit.initiated"); assert.equal(ok.payload["gate_open"], true);
  // the T&I account's gate is 6.2's Form 1014 row: not armed by this process's P&I plan
  assert.equal(e.timers.byCode("FNMA_F103_FORM1013_IN_EFFECT_GATE").some((t) => t.subject.id === "ARR-1:TI"), false);
});
test("6.1-T5: Given `ineligible_detected` on Thu 2026-10-15, then `due_at` = Tue 2026-10-20 17:00 ET; when `fnma_notified` on 10-19, then satisfied; when not by 10-20 17:00, then breached with `officer` critical escalation.", () => {
  assert.equal(toIso(ineligibilityNoticeDueMs(D("2026-10-15"))), at("2026-10-20", "17:00"));
  const bank = { id: "DEP-X", name: "Depository X", aba: "021000021", insured: true, well_capitalized: true, total_assets_cents: 1_200_000_000_000n, ratings: { idc: 118 } };
  const check = { depository: bank, ratings_as_of: D("2026-10-15"), checked_on: D("2026-10-15"), accounts: [{ account_id: SS_MBS, use: "S/S" as const }], fdic_as_of: D("2026-10-01"), prior_ratings: { idc: 128 } };
  // the rating monitor ingests IDC 128 → 118 on Thu 2026-10-15 → `ineligible_detected{detected_on}` arms the 3-BD notice (fannie_et: Fri 16, Mon 19, Tue 20, 17:00 ET)
  const a = engine("2026-10-15T14:00:00.000Z", ["6.1"]);
  const det = checkDepositoryRatings(a.events, check);
  assert.equal(det.ineligible_detected!.type, "custodial.depository.ineligible_detected"); assert.deepEqual(det.ineligible_detected!.aggregate, DEPOSITORY_AGG("DEP-X"));
  assert.equal(det.ineligible_detected!.payload["detected_on"], "2026-10-15"); assert.equal(det.ineligible_detected!.payload["prior_rating"], 128); assert.equal(det.ineligible_detected!.payload["rating"], 118); assert.equal(det.notify_by, "2026-10-20");
  const inst = a.timers.byCode("FNMA_A4102_DEPOSITORY_INELIGIBLE_NOTIFY_3BD")[0]!;
  assert.equal(inst.dueDate, "2026-10-20"); assert.equal(toIso(inst.dueAt!), at("2026-10-20", "17:00"));
  // the notice on 10-19 goes through `email.send` (allowlisted Fannie Mae recipient, partner copied) → `custodial.depository.fnma_notified`
  a.clock.set("2026-10-19T15:00:00.000Z");
  const { ctx, rt } = toolCtx(a, AGENT);
  const mail = tool("email.send");
  const notice = { to: FNMA_CUSTODIAL_TEAM, subject: "Custodial depository ineligibility — Depository X", template: "CUST-DEP-INELIG-v1", reason: "depository_ineligible", channel: "cbam", partner_copied: true, cbam_note: true, depository_id: "DEP-X", aggregate: DEPOSITORY_AGG("DEP-X"), body: "IDC 118 < 125; remedy plan attached" };
  assert.throws(() => mail.handler({ ...notice, partner_copied: false }, ctx, rt), /partner copied/);
  assert.equal(inst.status, "armed");
  mail.handler(notice, ctx, rt);
  const notified = a.events.ofType("custodial.depository.fnma_notified")[0]!;
  assert.equal(notified.payload["to"], FNMA_CUSTODIAL_TEAM); assert.equal(notified.payload["partner_copied"], true);
  assert.equal(inst.status, "satisfied"); assert.equal(inst.satisfiedByEventId, notified.id);
  assert.equal(ineligibilityNoticeOutcome({ detected_on: D("2026-10-15"), notified_at_ms: zonedEpochMs(D("2026-10-19"), "11:00", ET), now_ms: zonedEpochMs(D("2026-10-21"), "09:00", ET) }).status, "satisfied");
  // guardrails: recipients outside fanniemae.com need the depository/partner channel; no account-number-shaped body leaves those channels — no caller flag disables either
  const refuse = (code: string, i: Record<string, unknown>) => mail.guardrails!.find((g) => g.code === code)!.refuse(i, ctx);
  assert.match(refuse("ALLOWLISTED_RECIPIENTS", { to: "someone@gmail.com", recipient_allowlisted: true })!, /allowlist/);
  assert.equal(refuse("ALLOWLISTED_RECIPIENTS", { to: "drep@depositoryx.com", channel: "depository" }), undefined);
  assert.throws(() => mail.handler({ to: "drep@depositoryx.com", subject: "x", channel: "depository" }, ctx, rt), /email_allowlist/);
  assert.match(refuse("NO_ACCOUNT_NUMBER_IN_EMAIL", { to: "drep@depositoryx.com", body: "account 123456789", recipient_allowlisted: true })!, /account-number-shaped/);
  assert.equal(refuse("NO_ACCOUNT_NUMBER_IN_EMAIL", { to: "drep@depositoryx.com", channel: "depository", body: "account 123456789" }), undefined);
  // not notified by 10-20 17:00 → breached, officer critical
  const b = engine("2026-10-15T14:00:00.000Z", ["6.1"]);
  checkDepositoryRatings(b.events, check);
  assert.deepEqual(b.timers.evaluate("2026-10-20T20:59:00.000Z"), [], "not yet due at 16:59 ET");
  const breaches = b.timers.evaluate("2026-10-20T21:01:00.000Z");
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.instance.status, "breached"); assert.deepEqual(breaches[0]!.escalateTo, ["officer"]); assert.match(breaches[0]!.breachText, /critical/);
  const late = ineligibilityNoticeOutcome({ detected_on: D("2026-10-15"), notified_at_ms: null, now_ms: zonedEpochMs(D("2026-10-20"), "17:01", ET) });
  assert.equal(late.status, "breached"); assert.deepEqual(late.escalation, { role: "officer", severity: "critical" }); assert.equal(late.satisfied_by, "custodial.depository.fnma_notified");
});
test("6.1-T6: Given a lockbox receipt on Fri 2026-11-06, then the custodial deposit deadline is Tue 2026-11-10 (Wed 11-11 is a federal holiday but the servicer calendar is used; if the servicer is closed 11-11 the deadline is still 11-10).", () => {
  assert.equal(lockboxCustodialDeadline(D("2026-11-06")), "2026-11-10");
  const batch = { batch_id: "LBX-1106", lockbox_agent: "Lockbox Bank", received_on: D("2026-11-06"), items: [{ sequence: 1, amount_cents: 135_412n, bank_reference: "BR-1" }, { sequence: 2, amount_cents: 100_000n, bank_reference: "BR-2" }], total_cents: 235_412n, clearing_account_id: "ARR-1:CLR", custodial_account_id: SS_MBS };
  const run = (calendars?: CalendarSet) => {
    const e = engine("2026-11-06T18:00:00.000Z", ["6.1"], calendars);
    const r = ingestLockboxBatch(e.events, batch);
    assert.equal(r.clearing_due_on, "2026-11-09"); assert.equal(r.custodial_due_on, "2026-11-10");
    const inst = e.timers.byCode("FNMA_C1101_LOCKBOX_DEPOSIT_2BD")[0]!;
    assert.equal(inst.dueDate, "2026-11-10"); assert.deepEqual(inst.subject, LOCKBOX_BATCH_AGG("LBX-1106")); assert.equal(inst.anchorDate, "2026-11-06");
    return { e, inst, r };
  };
  const { e, inst, r } = run();
  run({ ...defaultCalendars, business_days_servicer: servicerCalendar({ closures: [D("2026-11-11")] }) });   // servicer closed on Veterans Day
  run({ ...defaultCalendars, business_days_servicer: servicerCalendar({ openOnHolidays: [D("2026-11-11")] }) });   // or open — the 2-BD point is Tuesday either way
  // the custodial bank's credit is matched to the batch on Mon 11-09 → `custodial.deposit.confirmed` satisfies the row; a mismatched credit is refused and the clock keeps running
  assert.throws(() => confirmCustodialDeposit(e.events, { subject: LOCKBOX_BATCH_AGG("LBX-1106"), custodial_account_id: SS_MBS, bank_line: { id: "BL-9", amount_cents: 235_400n, value_date: D("2026-11-09") }, expected_cents: 235_412n, deposited_on: D("2026-11-09") }), /not matched/);
  assert.equal(inst.status, "armed");
  const c = confirmCustodialDeposit(e.events, { subject: LOCKBOX_BATCH_AGG("LBX-1106"), custodial_account_id: SS_MBS, bank_line: { id: "BL-9", amount_cents: 235_412n, value_date: D("2026-11-09") }, expected_cents: 235_412n, deposited_on: D("2026-11-09") });
  assert.equal(inst.status, "satisfied"); assert.equal(inst.satisfiedByEventId, c.event.id);
  const def = e.registry.get("FNMA_C1101_LOCKBOX_DEPOSIT_2BD")!;
  assert.ok(eventMatches(def.triggerPattern!, r.event)); assert.ok(eventMatches(def.satisfiedPattern!, c.event));
  // a batch recorded late still anchors on the lockbox receipt date (`received_on`)
  const late = engine("2026-11-09T14:00:00.000Z", ["6.1"]); ingestLockboxBatch(late.events, batch);
  assert.equal(late.timers.byCode("FNMA_C1101_LOCKBOX_DEPOSIT_2BD")[0]!.dueDate, "2026-11-10");
  assert.throws(() => ingestLockboxBatch(e.events, { ...batch, batch_id: "LBX-BAD", total_cents: 1n }), /control total/);
  assert.throws(() => ingestLockboxBatch(e.events, { ...batch, batch_id: "LBX-EMPTY", items: [], total_cents: 0n }), /no items/);
});
test("6.1-T7: Given the executed PDF shows account number differing by one digit from the plan, then the form is not marked `in_effect` and the portal task reopens.", () => {
  const plan = PLAN_FACTS;
  const v = verifyExecutedForm({ plan, executed: { ...plan, account_number: "123456780" }, executed_document_hash: "sha256:9f2c" });
  assert.equal(v.matches, false); assert.deepEqual(v.mismatches, ["account_number"]); assert.equal(v.in_effect, false); assert.equal(v.reopen_task, true);
  assert.equal(verifyExecutedForm({ plan, executed: plan, executed_document_hash: "sha256:9f2c" }).in_effect, true);
  assert.equal(verifyExecutedForm({ plan, executed: plan, executed_document_hash: null }).in_effect, false);              // never in_effect without the executed hash
  const e = engine("2026-11-01T14:00:00.000Z", ["6.1"]);
  planCustodialAccounts(e.events, ARRANGEMENT);
  const gate = e.timers.byCode("FNMA_F103_FORM1013_IN_EFFECT_GATE").find((t) => t.subject.id === SS_MBS)!;
  const form = { form_id: "F-1013-1", custodial_account_id: SS_MBS, form_kind: "1013" as const, status: "fully_signed" as const, plan, executed_document_hash: "sha256:9f2c", as_of: D("2026-11-01") };
  const bad = markFormInEffect(e.events, e.escalations, { ...form, executed: { ...plan, account_number: "123456780" } });
  assert.equal(bad.in_effect, false); assert.equal(bad.status, "fully_signed"); assert.deepEqual(bad.mismatches, ["account_number"]);
  const task = e.escalations.opened.find((x) => x.id === bad.reopened_task_id)!;
  assert.equal(task.kind, "human_portal_task"); assert.equal(task.ownerRole, "fnma_portal_operator"); assert.equal(task.payload["task"], "cbam_form"); assert.equal(task.payload["reopened"], true); assert.deepEqual(task.payload["mismatches"], ["account_number"]);
  assert.equal(e.events.ofType("custodial.form.in_effect").length, 0); assert.equal(e.events.ofType("custodial.form.verification_failed").length, 1); assert.equal(gate.status, "armed");
  assert.throws(() => markFormInEffect(e.events, e.escalations, { ...form, executed: plan, executed_document_hash: null }), /executed document hash/);
  const early = markFormInEffect(e.events, e.escalations, { ...form, executed: plan, as_of: D("2026-10-31") });
  assert.equal(early.in_effect, false); assert.match(early.reason!, /effective date not reached/); assert.equal(gate.status, "armed");
  const good = markFormInEffect(e.events, e.escalations, { ...form, executed: plan });
  assert.equal(good.in_effect, true); assert.equal(good.status, "in_effect"); assert.equal(good.event!.payload["kind"], "1013"); assert.equal(good.event!.payload["executed_document_hash"], "sha256:9f2c"); assert.equal(gate.status, "satisfied");
  // the same verification runs behind `documents.write` for an executed form: the mismatch reopens the task there too
  const f = engine("2026-11-01T14:00:00.000Z", ["6.1"]); const { ctx, rt } = toolCtx(f, AGENT);
  const out = tool("documents.write").handler({ kind: "executed_form", id: "doc-1013", sha256: "sha256:9f2c", form_id: "F-1013-1", custodial_account_id: SS_MBS, form_kind: "1013", status: "fully_signed", plan, executed: { ...plan, account_number: "123456780" }, data: {} }, ctx, rt) as { verification: { in_effect: boolean; reopened_task_id: string | null } };
  assert.equal(out.verification.in_effect, false); assert.ok(out.verification.reopened_task_id); assert.equal(f.events.ofType("custodial.form.in_effect").length, 0);
});
test("6.1-T8: Given a DocuSign declined event, then status `signatures_declined`, `officer` escalation created, and no timer is deleted (cancelled with reason).", () => {
  const e = engine("2026-10-01T14:00:00.000Z", ["6.1"]);
  planCustodialAccounts(e.events, ARRANGEMENT);
  const pkg = prepareCbamPackage(e.events, e.escalations, PACKAGE);
  // only the CBAM portal task starts the 3-BD SLA (Thu 10-01 → Tue 10-06); the officer's DocuSign escalation does not
  const sla = e.timers.byCode("SM_CBAM_TASK_SLA_3BD"); assert.equal(sla.length, 1); assert.deepEqual(sla[0]!.subject, { kind: "escalation", id: pkg.portal_task_id }); assert.equal(sla[0]!.dueDate, "2026-10-06");
  const sent = sendFormForSignature(e.events, e.escalations, { form_id: "F-1013-1", custodial_account_id: SS_MBS, form_kind: "1013", status: "in_draft", cbam_form_number: "CBAM-1013-0001", sent_at: D("2026-10-01"), portal_task_id: pkg.portal_task_id }, OPERATOR);
  assert.equal(sla[0]!.status, "satisfied"); assert.equal(sent.signature_due_on, "2026-10-08"); assert.equal(sent.officer_chase_on, "2026-10-16", "10 servicer BD from Thu 10-01 skips Columbus Day (Mon 10-12)");
  const pending = e.timers.byCode("SM_CBAM_SIGNATURE_PENDING_5BD")[0]!; assert.equal(pending.status, "armed"); assert.equal(pending.dueDate, "2026-10-08"); assert.deepEqual(pending.subject, ACCOUNT_AGG(SS_MBS));
  const gate = e.timers.byCode("FNMA_F103_FORM1013_IN_EFFECT_GATE").find((t) => t.subject.id === SS_MBS)!;
  const rowsBefore = e.timers.all().length, escalationsBefore = e.escalations.opened.length;
  const r = ingestCbamFormStatus(e.events, e.escalations, e.timers, { form_id: "F-1013-1", custodial_account_id: SS_MBS, form_kind: "1013", status: "pending_signatures", cbam_status: "Signatures Declined", cbam_form_number: "CBAM-1013-0001", declined_by: "depository representative", decline_reason: "bank wants its own custodial agreement wording" }, DOCUSIGN);
  assert.equal(r.status, "signatures_declined"); assert.equal(r.event!.type, "custodial.form.signatures_declined"); assert.equal(r.event!.payload["funds_moved"], false);
  const esc = e.escalations.opened[escalationsBefore]!;
  assert.equal(e.escalations.opened.length, escalationsBefore + 1); assert.equal(esc.kind, "officer"); assert.equal(esc.ownerRole, "officer"); assert.equal(esc.id, r.decline!.escalation_id); assert.equal(esc.payload["funds_moved"], false); assert.deepEqual(esc.payload["attachments"], ["F-1-03 title language", "custodial_account@fanniemae.com"]);
  assert.deepEqual(r.decline!.timers_cancelled.map((t) => t.code), ["SM_CBAM_SIGNATURE_PENDING_5BD"]); assert.equal(r.decline!.timers_deleted, 0);
  assert.equal(e.timers.all().length, rowsBefore, "no timer row is deleted"); assert.ok(e.timers.all().some((i) => i.id === pending.id));
  assert.equal(pending.status, "cancelled"); assert.match(pending.cancelledReason!, /DocuSign declined by depository representative: bank wants/);
  assert.equal(e.events.ofType("timer.cancelled").length, 1); assert.equal(e.events.all().filter((x) => /delete/.test(x.type)).length, 0);
  assert.equal(gate.status, "armed", "the Form 1013 gate is not cancelled: the account still waits for in_effect");
  assert.deepEqual(e.timers.open().map((i) => i.code), ["FNMA_F103_FORM1013_IN_EFFECT_GATE", "FNMA_F103_FORM1013_IN_EFFECT_GATE", "FNMA_F103_FORM1013_IN_EFFECT_GATE", "FNMA_F103_FORM1013_IN_EFFECT_GATE"], "the officer escalation does not start a CBAM task SLA");
  assert.equal(e.timers.byCode("SM_CBAM_TASK_SLA_3BD").length, 1);
  assert.equal(formMachine.attempt("signatures_declined", "signed", OFFICER, {}).ok, false, "a declined form is redrafted, not signed");
  assert.equal(formMachine.attempt("signatures_declined", "redraft", AGENT, {}).ok, true);
  assert.throws(() => ingestCbamFormStatus(e.events, e.escalations, e.timers, { form_id: "F-1013-1", custodial_account_id: SS_MBS, form_kind: "1013", status: "signatures_declined", cbam_status: "In Effect", cbam_form_number: "CBAM-1013-0001" }, DOCUSIGN), /executed-document verification/);
});

test("6.1 rule 5 worked example → CUST-DEP-INELIG-v1 (A4-1-02): IDC 128 → 118 on Thu 2026-10-15, notify by Tue 10-20 17:00 ET, exposure = balance − $250,000, remedy plan; the notice passes its checklist only with the partner actually copied", () => {
  const p = ineligibleDepositoryPackage({ depository_name: "Depository X", aba: "021000021", agency: "idc", prior_rating: 128, new_rating: 118, floor: 125, detected_on: D("2026-10-15"), balances_cents: [{ account_id: "C-PI-SS-MBS", balance_cents: 170_000_000n }, { account_id: "C-TI-MAIN", balance_cents: 20_000_000n }], replacement_depository: "Depository Y", next_remittance_on: D("2026-11-18") });
  assert.equal(p.event, "custodial.depository.ineligible_detected"); assert.equal(p.account_status, "watch"); assert.equal(toIso(p.due_at_ms), at("2026-10-20", "17:00"));
  assert.equal(p.exposure_cents, 145_000_000n, "$1,700,000 − $250,000; the $200,000 account is fully insured");
  assert.equal(p.notice.template, "CUST-DEP-INELIG-v1"); assert.equal(p.notice.citation, "A4-1-02"); assert.equal(p.notice.to, "custodial_account@fanniemae.com"); assert.equal(p.notice.payload["partner_copied"], true);
  const reg = new NoticeRegistry(); publishSection06(reg);
  const v = reg.activeVersion("CUST-DEP-INELIG-v1", D("2026-10-15"))!;
  const payload = { ...v.samplePayload, ...p.notice.payload, business_days_after_detection: 1 };
  const r = render(v.source, payload);
  assert.match(r.text, /Depository X \(ABA 021000021\) no longer meets the custodial depository eligibility requirements of A4-1-02: IDC rating 118 \(previously 128; eligibility floor 125\), detected October 15, 2026/);
  assert.match(r.text, /Uninsured exposure at detection: \$1,450,000\.00/); assert.match(r.text, /due October 20, 2026/); assert.match(r.text, /The master servicer is copied/);
  assert.equal(evaluateChecklist(v, payload, r).passed, true);
  assert.equal(evaluateChecklist(v, { ...payload, business_days_after_detection: 4 }, r).blocking.map((b) => b.rule_id).join(), "three-bd");
  const notCopied = { ...payload, partner_copied: false };
  assert.equal(evaluateChecklist(v, notCopied, render(v.source, notCopied)).blocking.map((b) => b.rule_id).join(), "partner-copied");
  assert.equal(reg.template("CUST-DEP-INELIG-v1").ownerSection, "6.1");
});
test("6.1 rule 4 / FNMA_A4102_CLEARING_TO_CUSTODIAL_1BD: a clearing credit is swept within 1 servicer BD net of the servicing fee (round_half_up(UPB × rate / 12)) and retained late charges, as a balanced posting set", () => {
  // loan 1: UPB $250,000.00 × 0.25% / 12 = $52.083… → $52.08; P $312.45 + I $1,041.67 = $1,354.12 → sweep $1,302.04
  // loan 2: UPB $180,000.00 × 0.25% / 12 = $37.50; P $250.00 + I $750.00 = $1,000.00, late charge retained $35.00 → sweep $927.50
  assert.equal(servicingFeeCents(25_000_000n, "0.25"), 5_208n); assert.equal(servicingFeeCents(18_000_000n, "0.25"), 3_750n);
  const payments = [{ payment_id: "P-1", loan_id: "L-1", principal_cents: 31_245n, interest_gross_cents: 104_167n, upb_prior_cents: 25_000_000n, servicing_fee_rate_pct: "0.25", late_charges_retained_cents: 0n }, { payment_id: "P-2", loan_id: "L-2", principal_cents: 25_000n, interest_gross_cents: 75_000n, upb_prior_cents: 18_000_000n, servicing_fee_rate_pct: "0.25", late_charges_retained_cents: 3_500n }];
  const c = clearingSweep(payments);
  assert.equal(c.gross_cents, 235_412n); assert.equal(c.servicing_fee_cents, 8_958n); assert.equal(c.late_charges_retained_cents, 3_500n); assert.equal(c.sweep_cents, 222_954n);
  assert.deepEqual(c.per_loan.map((l) => l.sweep_cents), [130_204n, 92_750n]);
  // Fri 2026-11-06 credit in clearing → due Mon 11-09 (servicer calendar); the sweep on 11-09 satisfies the row on the same credit
  const e = engine("2026-11-06T20:00:00.000Z", ["6.1"]);
  const credit = ingestClearingCredit(e.events, { clearing_account_id: "ARR-1:CLR", line: { id: "BL-CLR-1", amount_cents: 235_412n, value_date: D("2026-11-06") }, credited_on: D("2026-11-06"), source: "bai2_prior_day", payments });
  assert.equal(credit.sweep_due_on, "2026-11-09");
  const inst = e.timers.byCode("FNMA_A4102_CLEARING_TO_CUSTODIAL_1BD")[0]!; assert.equal(inst.dueDate, "2026-11-09"); assert.deepEqual(inst.subject, CLEARING_CREDIT_AGG("BL-CLR-1")); assert.equal(inst.anchorDate, "2026-11-06");
  const s = sweepClearingToCustodial(e.events, { clearing_account_id: "ARR-1:CLR", custodial_account_id: SS_MBS, credit_id: "BL-CLR-1", credited_on: D("2026-11-06"), swept_on: D("2026-11-09"), payments });
  assert.equal(s.on_time, true); assert.equal(inst.status, "satisfied"); assert.equal(inst.satisfiedByEventId, s.event.id);
  assert.ok(postingSetBalanced(s.posting)); assert.deepEqual(s.posting.lines.map((l) => [l.account, l.amount_cents]), [[`custodial_pi_cash:${SS_MBS}`, 222_954n], ["corporate_cash", 12_458n], ["clearing_cash:ARR-1:CLR", -235_412n]]);
  assert.ok(s.posting.lines.every((l) => l.rule_ref === "6.1 rule 4 (F-1-03 servicing-fee split)"));
  assert.equal(s.event.payload["amount_cents"], 222_954n);
  const def = e.registry.get("FNMA_A4102_CLEARING_TO_CUSTODIAL_1BD")!; assert.ok(eventMatches(def.triggerPattern!, credit.event)); assert.ok(eventMatches(def.satisfiedPattern!, s.event));
  assert.throws(() => ingestClearingCredit(e.events, { clearing_account_id: "ARR-1:CLR", line: { id: "BL-CLR-2", amount_cents: 1n, value_date: D("2026-11-06") }, credited_on: D("2026-11-06"), source: "intraday", payments }), /payments total/);
  assert.throws(() => clearingSweep([]), RangeError);
});
test("6.1 FNMA_A4102_RATING_MONITOR_RECUR: activation (form in_effect ∧ debit whitelist ∧ statement feed ∧ title byte-for-byte) arms the monthly monitor, which each rating check satisfies and re-arms; a blocked activation names its guards", () => {
  const e = engine("2026-11-02T14:00:00.000Z", ["6.1"]);
  planCustodialAccounts(e.events, ARRANGEMENT);
  const opened = recordBankAccountOpened(e.events, { account_id: SS_MBS, status: "planned", depository_id: "DEP-X", account_use: "S/S", eligibility: evaluateDepositoryEligibility({ name: "X", insured: true, well_capitalized: true, total_assets_cents: 1_200_000_000_000n, ratings: { idc: 128 } }, "S/S"), opened_on: D("2026-10-05"), signature_card_document_id: "doc-sigcard" });
  assert.equal(opened.status, "form_pending");
  const base = { account_id: SS_MBS, kind: "pi" as const, remittance_type: "S/S" as const, pool_class: "mbs" as const, depository_id: "DEP-X", status: "form_pending" as const, form_status: "in_effect" as const, debit_whitelist_confirmed_at: "2026-10-20T15:00:00.000Z", statement_feed_id: "sftp-bai2-depx", statement_feed_test_files_received: true, expected_title: PI_TITLE, observed_title: PI_TITLE, activated_on: D("2026-11-02") };
  const blocked = activateAccount(e.events, { ...base, form_status: "fully_signed", debit_whitelist_confirmed_at: null, observed_title: PI_TITLE.replace("bailee", "bailee ") });
  assert.equal(blocked.activated, false); assert.deepEqual(blocked.blocked_by, ["form_in_effect", "debit_whitelist_confirmed", "title_mismatch"]); assert.equal(e.events.ofType("custodial.account.activated").length, 0);
  const a = activateAccount(e.events, base);
  assert.equal(a.activated, true); assert.equal(a.status, "active"); assert.equal(a.event!.payload["activated_on"], "2026-11-02"); assert.equal(a.partner_notification!.payload["template"], "PARTNER_CUSTODIAL_ACCOUNT_ACTIVATED");
  const monitor = e.timers.byCode("FNMA_A4102_RATING_MONITOR_RECUR"); assert.equal(monitor.length, 1); assert.equal(monitor[0]!.dueDate, "2026-12-02"); assert.deepEqual(monitor[0]!.subject, ACCOUNT_AGG(SS_MBS));
  const chk = checkDepositoryRatings(e.events, { depository: { id: "DEP-X", name: "X", insured: true, well_capitalized: true, total_assets_cents: 1_200_000_000_000n, ratings: { idc: 128 } }, ratings_as_of: D("2026-11-30"), checked_on: D("2026-12-01"), accounts: [{ account_id: SS_MBS, use: "S/S" }], fdic_as_of: D("2026-11-15") });
  assert.equal(chk.eligibility_status, "eligible"); assert.equal(chk.next_check_due, "2027-01-01");
  const after = e.timers.byCode("FNMA_A4102_RATING_MONITOR_RECUR");
  assert.equal(after[0]!.status, "satisfied"); assert.equal(after.length, 2); assert.equal(after[1]!.status, "armed"); assert.equal(after[1]!.dueDate, "2027-01-01", "recurring: re-armed monthly from the check");
  const def = e.registry.get("FNMA_A4102_RATING_MONITOR_RECUR")!; assert.ok(eventMatches(def.triggerPattern!, a.event!)); assert.ok(eventMatches(def.satisfiedPattern!, chk.events[0]!));
  assert.throws(() => activateAccount(e.events, { ...base, account_id: "" }), RangeError);
});
test("6.1 FNMA_A2107_CUSTODIAL_EVIDENCE_BEFORE_629_GATE: the inbound 1.2 batch arms the evidence gate (evaluator), which opens only when every remittance type in the transfer file has an active P&I and T&I account — 30 days before the transfer date", () => {
  const e = engine("2026-09-15T14:00:00.000Z", ["6.1"]);
  const ev = proposeBatch(e.events, { batch_id: "B-1", type: "master_to_sub", transfer_date: D("2026-12-01"), first_batch_for_partner: true, partner_id: "PARTNER-1" }, AGENT);
  const gate = e.timers.byCode("FNMA_A2107_CUSTODIAL_EVIDENCE_BEFORE_629_GATE"); assert.equal(gate.length, 1); assert.equal(gate[0]!.note, "evaluator:6.1.activeAccountsForEveryRemittanceType"); assert.deepEqual(gate[0]!.subject, { kind: "transfer_batch", id: "B-1" });
  assert.ok(eventMatches(e.registry.get("FNMA_A2107_CUSTODIAL_EVIDENCE_BEFORE_629_GATE")!.triggerPattern!, ev));
  assert.equal(custodialEvidenceDueOn(D("2026-12-01")), "2026-11-01");
  const accounts = [{ kind: "pi" as const, status: "active" as const, remittance_type: "A/A" as const }, { kind: "pi" as const, status: "active" as const, remittance_type: "S/S" as const }, { kind: "pi" as const, status: "form_pending" as const, remittance_type: "S/A" as const }, { kind: "ti" as const, status: "active" as const, remittance_types: ["A/A", "S/A", "S/S"] as const }];
  const facts = custodialEvidenceFacts({ transfer_remittance_types: ["A/A", "S/A", "S/S"], accounts });
  assert.deepEqual(facts, { remittance_types: ["A/A", "S/A", "S/S"], active_pi_account_types: ["A/A", "S/S"], active_ti_account_types: ["A/A", "S/A", "S/S"] });
  const closed = evaluateGate("6.1.activeAccountsForEveryRemittanceType", facts); assert.equal(closed.open, false); assert.match(closed.reason!, /S\/A/);
  assert.equal(evaluateGate("6.1.activeAccountsForEveryRemittanceType", custodialEvidenceFacts({ transfer_remittance_types: ["A/A", "S/S"], accounts })).open, true);
  // an outbound batch (17.1 spells its type `transfer_type`, direction=out) does not arm the inbound evidence gate
  e.events.append({ type: "transfer.batch.proposed", aggregate: { kind: "transfer_batch", id: "OUT-1" }, actor: SYSTEM, payload: { batch_id: "OUT-1", direction: "out", transfer_type: "sub_to_master" } });
  assert.equal(e.timers.byCode("FNMA_A2107_CUSTODIAL_EVIDENCE_BEFORE_629_GATE").length, 1);
});
test("6.1 tools: the nine registry tool strings are on the bus for custodial-recon; `timer.start/satisfy` runs the act behind each event and refuses a bare append; the CBAM package validates the User Guide's field rules", () => {
  const spec = loadAgentsFile().processes.find((p) => p.process === "6.1")!;
  assert.deepEqual(TOOLS_6_1.map((t) => t.name).sort(), [...spec.tools].sort()); assert.ok(TOOLS_6_1.every((t) => t.agent === "custodial-recon" && t.process === "6.1"));
  const e = engine("2026-10-01T14:00:00.000Z", ["6.1"]); const { ctx, rt } = toolCtx(e, AGENT);
  const satisfy = tool("timer.start/satisfy");
  assert.throws(() => satisfy.handler({ op: "satisfy", event_type: "custodial.depository.fnma_notified", aggregate: DEPOSITORY_AGG("DEP-X") }, ctx, rt), /event-driven/);
  assert.throws(() => satisfy.handler({ op: "satisfy" }, ctx, rt), RangeError);
  assert.equal(e.events.ofType("custodial.depository.fnma_notified").length, 0);
  assert.match(satisfy.guardrails!.find((g) => g.code === "IN_EFFECT_NEEDS_HASH")!.refuse({ op: "satisfy", event_type: "custodial.form.in_effect", form_id: "F", executed_document_hash: "" }, ctx)!, /executed_document_hash/);
  // the planning tool stores the accounts and emits the planned events; the satisfy op for `custodial.account.activated` runs activateAccount
  const planned = tool("custodial.plan_accounts").handler({ ...ARRANGEMENT }, ctx, rt) as { accounts: { account_id: string }[] };
  assert.equal(planned.accounts.length, 6); assert.equal(rt.store.list("custodial_accounts").length, 6); assert.equal(e.events.ofType("custodial.account.planned").length, 6);
  const pkg = tool("cbam.prepare_package").handler({ package: PACKAGE, channel: "cbam" }, ctx, rt) as { status: string; portal_task_id: string };
  assert.equal(pkg.status, "in_draft"); assert.equal(rt.store.get("custodial_forms", "F-1013-1")!.data.status, "in_draft"); assert.equal(e.timers.byCode("SM_CBAM_TASK_SLA_3BD").length, 1);
  assert.throws(() => tool("cbam.prepare_package").handler({ package: { ...PACKAGE, depository: { ...PACKAGE.depository, physical_address: "PO Box 12" }, remittance_type: "S/S" } }, ctx, rt), /no PO boxes/);
  assert.match(tool("cbam.prepare_package").guardrails![0]!.refuse({ package: PACKAGE, channel: "gmail" }, ctx)!, /CBAM, the depository or the partner/);
  const opCtx = toolCtx(e, OPERATOR); opCtx.rt.store.put("custodial_forms", "F-1013-1", { status: "in_draft" }, OPERATOR, e.clock.now());
  const sent = satisfy.handler({ op: "satisfy", event_type: "custodial.form.sent_for_signature", form_id: "F-1013-1", custodial_account_id: SS_MBS, cbam_form_number: "CBAM-1013-0001", sent_at: "2026-10-01", portal_task_id: pkg.portal_task_id }, opCtx.ctx, opCtx.rt) as { status: string };
  assert.equal(sent.status, "pending_signatures"); assert.equal(e.timers.byCode("SM_CBAM_TASK_SLA_3BD")[0]!.status, "satisfied"); assert.equal(e.timers.byCode("SM_CBAM_SIGNATURE_PENDING_5BD")[0]!.dueDate, "2026-10-08");
  const lbx = satisfy.handler({ op: "satisfy", event_type: "lockbox.batch.received", batch_id: "LBX-1", lockbox_agent: "Lockbox Bank", received_on: "2026-11-06", custodial_account_id: SS_MBS, items: [{ sequence: 1, amount_cents: 100n, bank_reference: "BR" }] }, ctx, rt) as { custodial_due_on: string };
  assert.equal(lbx.custodial_due_on, "2026-11-10");
});
