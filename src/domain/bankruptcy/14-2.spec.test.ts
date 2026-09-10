// 14.2 Payment change notices (Rule 3002.1)
// spec/sections/14-bankruptcy/14-2-payment-change-notices-rule-3002-1.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, daysBetween, addDays, dayOfWeek } from "../../kernel/calendar/date.ts";
import { isFederalHoliday } from "../../kernel/calendar/holidays.ts";
import { levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, computeDue } from "../../kernel/timers/index.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_14_2 } from "../../app/tools/section14-2.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { paymentChangeDeadline, responseDue, type FeeItem } from "./notices.ts";
import { ch13Content } from "./statement.ts";
import { detectChange, deadlineCalc, timeliness9006, postpetitionEscrowChange, untimelyNoticeBilling, armChangeNotice, supersedingNotice, feeBatchSchedule, form410s2Lines, noticeDeadline180, precludeAndWriteOff, collectibleFees, form410c13nr, form410c13m1r, g4MotionWindow, b4MotionHold, applyCourtOrder, reliefOrderDecision, form410s1, renderCourtForm, ingestFeeItem, planCompletionFreeze, responseTrigger, effectiveOnDueDate, figuresRequest, rollForward9006Court, type NoticeRow, type PostpetitionFeeItem, type Amortization, type CaseFacts, type FrozenLedgerViews } from "./ops-14-2.ts";
import { balanceAfter } from "../lossmit/flexmod.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";

/** Fixture BK-13-A: Chapter 13, principal residence, cure-and-maintain plan, no relief order. */
const BK13A: CaseFacts = { chapter: "13", principal_residence: true, treatment: "cure_and_maintain", relief_order_effective: false, case_open: true, case_id: "case-BK-13-A" };
/** Fixture BK-13-A note: $325,000 at 6.500%/360, first installment 2023-08-01 (payment #95 = 2031-06-01). */
const BK13A_NOTE: Amortization = { original_principal_cents: 32_500_000n, rate_pct: "6.500", term_months: 360, first_due: D("2023-08-01") };
const PI = 205_422n, ESCROW_NEW = 75_250n, OLD_TOTAL = 269_922n, NEW_TOTAL = 280_672n;
const noon = (d: string) => Date.parse(`${d}T12:00:00Z`);
const LOAN = "L-BK-13-A", CASE = "case-BK-13-A";
const BK: Actor = { kind: "agent", id: "bankruptcy-ops" };
const SIGNER: Actor = { kind: "human", id: "u-signer", role: "signing_officer" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
/** The 14.1 docket monitor's event, as a 14.2 test appends it (served date and method parsed from the certificate of service). */
const docket = (kind: string, extra: Record<string, unknown>) => ({ type: "bankruptcy.docket.event.received", loanId: LOAN, actor: { kind: "system", id: "docket-monitor" } as Actor, payload: { kind, case_id: CASE, ...extra } });
const CM_ECF_SERVICE = [{ party: "trustee", method: "cm_ecf" }, { party: "debtor_attorney", method: "cm_ecf" }, { party: "debtor", method: "mail" }];
const ANALYSIS = { id: "ea-2026-09-25", pi_new_cents: PI, escrow_new_cents: ESCROW_NEW, ledger_snapshot_hash: "sha256:ledger-2026-09-25" };
const DETECT = { loan_id: LOAN, case_id: CASE, claim_no: "7", source: "escrow_analysis", old_total_cents: OLD_TOTAL, new_total_cents: NEW_TOTAL, effective_due_date: "2026-11-01", chapter: "13", treatment: "cure_and_maintain", principal_residence: true, detected_on: "2026-09-25", trigger_event_id: "evt-escrow-approved-2026-09-25", pi_old_cents: PI, pi_new_cents: PI, escrow_old_cents: 64_500n, escrow_new_cents: ESCROW_NEW, escrow_statement_document_id: "doc-escrow-2026-09-25" };
const RENDER_S1 = { loan_id: LOAN, form: "410S-1", effective_due_date: "2026-11-01", pi_new_cents: PI, escrow_new_cents: ESCROW_NEW, new_total_cents: NEW_TOTAL, parts: [1], escrow_old_cents: 64_500n, escrow_statement_document_id: "doc-escrow-2026-09-25", account_last4: "4821", signer_role: "authorized_agent", analysis: ANALYSIS, notice_date: "2026-09-28" };

/** The bus with only the 14.2 tools bound, an event store the TimerEngine (14.1 + 14.2 rows, section overrides applied) listens to, and a movable clock. */
function harness(now: string) {
  const clock = new FixedClock(now); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["14.1", "14.2", "3.2"] });   // BK_3002_1_PAYMENT_CHANGE_21 is keyed to its 3.2 cross-reference row in the registry
  const ctx: UowContext = { loanId: LOAN, events, ledger: new MemoryLedger(), timers, clock, decide: () => {} };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_14_2); const bus = new CommandBus(agents);
  const run = async <T = any>(tool: string, input: ToolInput, actor: Actor = BK, at?: string): Promise<T> => { if (at) clock.set(at); return (await bus.execute(cmds.get(toolKey("14.2", tool))!, actor, input, ctx)).output as T; };
  const refused = async (tool: string, input: ToolInput, code: string, actor: Actor = BK) => assert.rejects(run(tool, input, actor), (e: unknown) => e instanceof CommandRefused && e.code === code, `${tool} refused [${code}]`);
  const inst = (code: string) => timers.byCode(code);
  const last = (code: string) => { const all = inst(code); assert.ok(all.length, `${code} armed`); return all[all.length - 1]!; };
  const emitted = (type: string) => events.ofType(type);
  /** Detect → render → hand off → sign → file and serve a 410S-1 on `filedOn` (CM/ECF to trustee and counsel, mail to the debtor the same day). */
  const fileS1 = async (filedOn: string, detect: Record<string, unknown> = {}, render: Record<string, unknown> = {}) => {
    const d = await run("bk.change.detect", { ...DETECT, ...detect }, BK, "2026-09-25T14:00:00Z");
    const pkg = await run("bk.notice.render", { ...RENDER_S1, notice_id: d.notice_id, ...render }, BK, "2026-09-28T14:00:00Z");
    const f = await run("attorney.send_package", { loan_id: LOAN, op: "hand_off", filing_type: "s1_payment_change", package_id: pkg.package_id, notice_id: d.notice_id, deadline_file_serve: d.deadline_file_serve, effective_due_date: String(detect.effective_due_date ?? DETECT.effective_due_date) });
    await run("attorney.send_package", { loan_id: LOAN, op: "signed", filing_id: f.id, signer_id: "u-signer", signed_form_sha256: "abc" }, SIGNER, "2026-09-28T15:00:00Z");
    const c = await run("attorney.send_package", { loan_id: LOAN, op: "confirm_filed_served", filing_id: f.id, filed_at: `${filedOn}T15:10:00Z`, served_at: `${filedOn}T15:10:00Z`, nef_at: `${filedOn}T15:10:00Z`, nef_docket_no: "42", certificate_of_service_document_id: "doc-cos-1", service: CM_ECF_SERVICE, mail_manifest_id: "mm-1", mail_manifest_date: filedOn }, BK, `${filedOn}T16:00:00Z`);
    return { detect: d, pkg, filing: f, confirm: c };
  };
  return { ctx, rt, run, refused, clock, events, timers, inst, last, emitted, fileS1 };
}
/** A 14.1 `bankruptcy_ledger_views` record for BK-13-A as of a date: every post-petition installment through `through` paid two days after due unless listed in `unpaid`. */
const ledgerView = (rows: string[], unpaid: string[] = [], amount = NEW_TOTAL) => ({ loan_id: LOAN, case_id: CASE, prepetition_arrearage_cents: 0n, postpetition: rows.map((due) => ({ due, amount_cents: amount, paid_cents: unpaid.includes(due) ? 0n : amount, ...(unpaid.includes(due) ? {} : { received_on: addDays(D(due), 2) }) })), unpaid_noticed_fees_cents: 0n, escrow_balance_cents: 150_000n, unapplied_cents: 0n, deferred_interest_cents: 0n, amortization: BK13A_NOTE, escrow_monthly_cents: ESCROW_NEW, cure_received_cents: 1_424_194n, history: rows.map((due) => ({ due, received_on: unpaid.includes(due) ? null : addDays(D(due), 2), amount_cents: unpaid.includes(due) ? 0n : amount })), snapshot_hash: "sha256:view-2031" });

test("14.2-T1: Given the escrow analysis approved 2026-09-25 with effective due date 2026-11-01, then `BK_3002_1_PAYMENT_CHANGE_21` is due 2026-10-09 (backward roll from Sunday 10-11), the target is 2026-09-25, and a filing served 2026-09-30 satisfies it (32 days).", async () => {
  const d = detectChange({ source: "escrow_analysis", old_total_cents: OLD_TOTAL, new_total_cents: NEW_TOTAL, effective_due_date: D("2026-11-01"), detected_on: D("2026-09-25"), trigger_event_id: "evt-escrow-approved-2026-09-25" }, BK13A);
  assert.equal(d.in_scope, true); assert.equal(d.notice_required, true); assert.equal(d.change_kind, "increase"); assert.equal(d.part, 1); assert.equal(d.status, "computed");
  assert.equal(d.deadline_file_serve, "2026-10-09"); assert.equal(d.target_file_date, "2026-09-25"); assert.equal(d.row_due_by, "2026-09-28");
  // Rule 9006(a) backward count: Oct 31 = day 1 … Oct 11 = day 21 (Sunday) → Saturday → Friday 2026-10-09; the target −35 (Sunday 09-27) steps back to Friday 09-25
  assert.equal(addDays(D("2026-11-01"), -21), "2026-10-11"); assert.equal(dayOfWeek(D("2026-10-11")), 0);
  assert.deepEqual(d.deadline_calc.holidays_applied, [{ date: "2026-10-11", reason: "Sunday" }, { date: "2026-10-10", reason: "Saturday" }]);
  assert.equal(d.deadline_calc.anchor, "2026-11-01"); assert.equal(d.deadline_calc.roll_rule, "frbp_9006_backward"); assert.equal(d.deadline_calc.result, "2026-10-09"); assert.equal(d.deadline_calc.target, "2026-09-25");
  // the decision record carries the spec's fields
  assert.equal(d.decision.case_id, "case-BK-13-A"); assert.equal(d.decision.trigger_event_id, "evt-escrow-approved-2026-09-25"); assert.match(d.decision.computation_hash, /^[0-9a-f]{64}$/); assert.deepEqual(d.decision.deadline_calc, d.deadline_calc);
  assert.deepEqual(d.decision.service_list, ["debtor", "debtor_attorney", "trustee"]); assert.equal(d.decision.rule_set_version, "frbp.2025-12; fnma.bk_fees.2025-11-12"); assert.match(d.decision.model_version, /deterministic/); assert.equal(d.decision.outcome, "notice_required");
  // filed and served 2026-09-30 → 32 days' notice, timely, effective 2026-11-01
  const t = timeliness9006({ effective_due_date: D("2026-11-01"), filed_on: D("2026-09-30"), served_on: D("2026-09-30"), increase: true });
  assert.equal(t.timely, true); assert.equal(t.days_notice, 32); assert.equal(t.deadline, "2026-10-09"); assert.equal(t.effective_date_applied, "2026-11-01"); assert.equal(t.breach, null); assert.equal(t.sanctions_exposure, false);
  // "filed and served" means both acts by the deadline: the mailed debtor copy a day late fails it
  assert.equal(timeliness9006({ effective_due_date: D("2026-11-01"), filed_on: D("2026-10-09"), served_on: D("2026-10-10"), increase: true }).timely, false);
  // served Saturday 2026-10-10: still 22 days' notice, but past the 9006 deadline → untimely with sanctions exposure; (b)(3) leaves Nov 1 as the effective date
  const sat = timeliness9006({ effective_due_date: D("2026-11-01"), filed_on: D("2026-10-10"), served_on: D("2026-10-10"), increase: true });
  assert.equal(sat.timely, false); assert.equal(sat.days_notice, 22); assert.equal(sat.late_by_days, 1); assert.equal(sat.effective_date_applied, "2026-11-01"); assert.equal(sat.sanctions_exposure, true); assert.equal(sat.breach!.severity, 1);
  // the registry row after the §14.2 overrides: the rolled deadline is the anchor (the step grammar has no backward roll), satisfied only by a timely filed + served notice
  const row = loadOverriddenRegistry().get("BK_3002_1_PAYMENT_CHANGE_21")!;
  assert.match(row.trigger, /bankruptcy\.payment_change_notice\.created\{in_scope=true\}/); assert.equal(row.anchorField, "deadline_file_serve"); assert.equal(row.satisfiedPattern!.type, "bankruptcy.payment_change_notice.filed_served"); assert.deepEqual(row.satisfiedPattern!.conditions, [{ field: "timely", op: "=", value: "true" }]); assert.match(row.overrideWhy!, /9006\(a\)\(1\)\(C\)/);
  assert.equal(computeDue(row.offsetParsed, d.deadline_file_serve, noon("2026-10-09")).dueDate, "2026-10-09");
  const target = loadOverriddenRegistry().get("SM_BK_3002_1_TARGET_LEAD_35")!; assert.equal(target.anchorField, "target_file_date"); assert.equal(computeDue(target.offsetParsed, d.target_file_date, noon("2026-09-25")).dueDate, "2026-09-25");
  // through the bus and the timer engine: the 3.2 analysis schedules the change; bk.change.detect creates the row (DETECT_1BD satisfied) and arms the 21-day gate on 2026-10-09 and the −35 target on 2026-09-25
  const h = harness("2026-09-25T14:00:00Z");
  h.events.append({ type: "payment.change.scheduled", loanId: LOAN, actor: { kind: "system", id: "escrow-3.2" }, payload: { source: "escrow_analysis", old_total_cents: OLD_TOTAL, new_total_cents: NEW_TOTAL, effective_due_date: "2026-11-01" } });
  assert.equal(h.last("SM_BK_PAYMENT_CHANGE_DETECT_1BD").dueDate, "2026-09-28");
  const r = await h.fileS1("2026-09-30");
  assert.equal(r.detect.notice_id, `pcn-${LOAN}-2026-11-01`); assert.equal(r.detect.deadline_file_serve, "2026-10-09"); assert.equal(h.rt.store.get("bk_payment_change_notices", r.detect.notice_id as string)!.data.fnma_fee_claimable, true);
  assert.equal(h.last("SM_BK_PAYMENT_CHANGE_DETECT_1BD").status, "satisfied");
  const gate = h.last("BK_3002_1_PAYMENT_CHANGE_21"); assert.equal(gate.anchorDate, "2026-10-09"); assert.equal(gate.dueDate, "2026-10-09");
  const lead = h.last("SM_BK_3002_1_TARGET_LEAD_35"); assert.equal(lead.dueDate, "2026-09-25"); assert.equal(lead.status, "satisfied", "the package handed to counsel on 2026-09-25 satisfies the internal target");
  assert.equal(r.confirm.timeliness.timely, true); assert.equal(r.confirm.timeliness.days_notice, 32); assert.equal(r.confirm.status, "filed_served");
  assert.equal(gate.status, "satisfied"); assert.equal(h.emitted("bankruptcy.payment_change_notice.filed_served")[0]!.payload.timely, true); assert.equal(h.emitted("payment.change.effective_date.pushed").length, 0);
  assert.equal(h.last("FRBP_3002_1B4_OBJECTION_WINDOW").note, "evaluator:14.2.noB4MotionBeforeDueDate");
  assert.equal(h.rt.store.get("bk_payment_change_notices", r.detect.notice_id as string)!.data.status, "filed_served");
  // never back-dated: the NEF timestamp and the mail manifest are required proofs, and the recorded times can never precede them
  const f2 = await h.run("attorney.send_package", { loan_id: LOAN, op: "hand_off", filing_type: "s1_payment_change", package_id: r.pkg.package_id, notice_id: r.detect.notice_id });
  await h.refused("attorney.send_package", { loan_id: LOAN, op: "confirm_filed_served", filing_id: f2.id, filed_at: "2026-09-30T15:10:00Z", served_at: "2026-09-30T15:10:00Z", nef_docket_no: "43", certificate_of_service_document_id: "doc-cos-2" }, "NEVER_BACKDATED");
  await h.refused("attorney.send_package", { loan_id: LOAN, op: "confirm_filed_served", filing_id: f2.id, filed_at: "2026-09-30T15:10:00Z", served_at: "2026-09-30T15:10:00Z", nef_at: "2026-09-30T15:10:00Z", nef_docket_no: "43", certificate_of_service_document_id: "doc-cos-2", service: CM_ECF_SERVICE }, "NEVER_BACKDATED");
  await h.refused("attorney.send_package", { loan_id: LOAN, op: "confirm_filed_served", filing_id: f2.id, filed_at: "2026-09-30T15:10:00Z", served_at: "2026-09-30T15:10:00Z", nef_at: "2026-10-01T09:00:00Z", nef_docket_no: "43", certificate_of_service_document_id: "doc-cos-2", service: CM_ECF_SERVICE, mail_manifest_id: "mm-2", mail_manifest_date: "2026-09-30" }, "NEVER_BACKDATED");
  // on the due date, absent a (b)(4) motion, the notice is effective and the monitor closes
  const eff = await h.run("bk.change.detect", { loan_id: LOAN, op: "effective", notice_id: r.detect.notice_id }, BK, "2026-11-01T12:00:00Z");
  assert.equal(eff.status, "effective"); assert.equal(eff.bills_cents, NEW_TOTAL); assert.equal(h.last("FRBP_3002_1B4_OBJECTION_WINDOW").status, "satisfied");
});
test("14.2-T2: Given the same notice filed and served 2026-10-15, then `timely=false`, `effective_date_applied=2026-12-01`, the November installment bills $2,699.22, and 3.2 receives `payment.change.effective_date.pushed`.", async () => {
  const late = untimelyNoticeBilling({ effective_due_date: D("2026-11-01"), filed_on: D("2026-10-15"), served_on: D("2026-10-15"), old_total_cents: OLD_TOTAL, new_total_cents: NEW_TOTAL, timing_loss_monthly_cents: 10_750n });
  assert.equal(late.timely, false); assert.equal(late.deadline, "2026-10-09"); assert.equal(late.days_notice, 17); assert.equal(late.effective_date_applied, "2026-12-01");
  // (b)(3): 2026-10-15 + 21 = 2026-11-05 → the first due date at least 21 days after the untimely notice is the 2026-12-01 installment
  assert.equal(addDays(D("2026-10-15"), 21), "2026-11-05");
  assert.deepEqual(late.installments, [{ due: "2026-11-01", bills_cents: 269_922n }, { due: "2026-12-01", bills_cents: 280_672n }]);
  assert.deepEqual(late.pushed_event, { type: "payment.change.effective_date.pushed", from: "2026-11-01", to: "2026-12-01" });
  // 14.2-Q4: the one-month escrow timing loss ($107.50) is absorbed into the next analysis — no re-notice; the noticed Dec amount stands
  assert.equal(late.timing_loss_cents, 10_750n); assert.equal(late.re_notice, false); assert.equal(late.sanctions_exposure, true);
  const t = timeliness9006({ effective_due_date: D("2026-11-01"), filed_on: D("2026-10-15"), served_on: D("2026-10-15"), increase: true });
  assert.equal(t.late_by_days, 6); assert.deepEqual(t.breach, { severity: 1, timer: "BK_3002_1_PAYMENT_CHANGE_21", gate: "new amount may not be billed on the scheduled date" });
  // through the bus: the gate breaches on 2026-10-09, the late filing never satisfies it (timely=false), 3.2 gets the pushed date, sev-1 is escalated and the breached instance closes on the (b)(3) recomputation
  const h = harness("2026-09-25T14:00:00Z");
  const d = await h.run("bk.change.detect", DETECT); const pkg = await h.run("bk.notice.render", { ...RENDER_S1, notice_id: d.notice_id, notice_date: "2026-10-10" }, BK, "2026-10-10T14:00:00Z");
  const f = await h.run("attorney.send_package", { loan_id: LOAN, op: "hand_off", filing_type: "s1_payment_change", package_id: pkg.package_id, notice_id: d.notice_id, deadline_file_serve: d.deadline_file_serve, effective_due_date: "2026-11-01" });
  assert.deepEqual(h.timers.evaluate("2026-10-10T12:00:00Z").map((b) => [b.instance.code, b.severity]), [["BK_3002_1_PAYMENT_CHANGE_21", null]]); assert.equal(h.last("BK_3002_1_PAYMENT_CHANGE_21").status, "breached");
  const c = await h.run("attorney.send_package", { loan_id: LOAN, op: "confirm_filed_served", filing_id: f.id, filed_at: "2026-10-15T15:10:00Z", served_at: "2026-10-15T15:10:00Z", nef_at: "2026-10-15T15:10:00Z", nef_docket_no: "42", certificate_of_service_document_id: "doc-cos-1", service: CM_ECF_SERVICE, mail_manifest_id: "mm-1", mail_manifest_date: "2026-10-15" }, BK, "2026-10-15T16:00:00Z");
  assert.equal(c.timeliness.timely, false); assert.equal(c.timeliness.effective_date_applied, "2026-12-01");
  const n = h.rt.store.get("bk_payment_change_notices", d.notice_id as string)!.data; assert.equal(n.timely, false); assert.equal(n.effective_date_applied, "2026-12-01");
  const fs = h.emitted("bankruptcy.payment_change_notice.filed_served")[0]!; assert.equal(fs.payload.timely, false); assert.equal(eventMatches(loadOverriddenRegistry().get("BK_3002_1_PAYMENT_CHANGE_21")!.satisfiedPattern!, fs), false, "an untimely filing never satisfies the gate");
  assert.deepEqual(h.emitted("payment.change.effective_date.pushed").map((e) => [e.payload.from, e.payload.to]), [["2026-11-01", "2026-12-01"]]);
  const gate = h.last("BK_3002_1_PAYMENT_CHANGE_21"); assert.equal(gate.status, "cancelled"); assert.match(gate.cancelledReason!, /3002\.1\(b\)\(3\).*2026-12-01/);
  assert.deepEqual(h.rt.escalations.opened.map((e) => [e.kind, e.payload.timer]), [["sev1", "BK_3002_1_PAYMENT_CHANGE_21"]]);
  // the November installment bills the old amount: on the due date the notice is not yet effective (effective_date_applied is Dec 1)
  const nov = await h.run("bk.change.detect", { loan_id: LOAN, op: "effective", notice_id: d.notice_id }, BK, "2026-11-01T12:00:00Z"); assert.equal(nov.effective, true); assert.equal(h.emitted("bankruptcy.payment_change_notice.status_changed").at(-1)!.payload.effective_date_applied, "2026-12-01");
  assert.equal(untimelyNoticeBilling({ effective_due_date: D("2026-11-01"), filed_on: D("2026-10-15"), served_on: D("2026-10-15"), old_total_cents: OLD_TOTAL, new_total_cents: NEW_TOTAL }).installments[0]!.bills_cents, 269_922n);
});
test("14.2-T3: Given a late-noticed decrease, then the lower amount applies on the actual due date.", async () => {
  // rule 2 decrease variant: an escrow decrease to $2,650.00 noticed late (2026-10-15 for the 2026-11-01 installment)
  const dec = untimelyNoticeBilling({ effective_due_date: D("2026-11-01"), filed_on: D("2026-10-15"), served_on: D("2026-10-15"), old_total_cents: OLD_TOTAL, new_total_cents: 265_000n });
  assert.equal(dec.timely, false); assert.equal(dec.effective_date_applied, "2026-11-01");
  assert.deepEqual(dec.installments, [{ due: "2026-11-01", bills_cents: 265_000n }, { due: "2026-12-01", bills_cents: 265_000n }]);
  assert.equal(dec.pushed_event, null); assert.equal(dec.timing_loss_cents, 0n);
  // (b)(3): a decrease takes effect on the actual due date "even if it is prior to the notice"
  const after = untimelyNoticeBilling({ effective_due_date: D("2026-11-01"), filed_on: D("2026-11-05"), served_on: D("2026-11-05"), old_total_cents: OLD_TOTAL, new_total_cents: 265_000n });
  assert.equal(after.effective_date_applied, "2026-11-01"); assert.equal(after.installments[0]!.bills_cents, 265_000n); assert.equal(after.days_notice, -4);
  // rule 10: a decrease-only notice is still filed — the rule, not the fee schedule, governs
  const d = detectChange({ source: "escrow_analysis", old_total_cents: OLD_TOTAL, new_total_cents: 265_000n, effective_due_date: D("2026-11-01"), detected_on: D("2026-10-14") }, BK13A);
  assert.equal(d.change_kind, "decrease"); assert.equal(d.notice_required, true); assert.equal(d.status, "computed");
  // equal totals are no change: nothing to notice (change_kind ∈ {increase, decrease})
  const none = detectChange({ source: "escrow_analysis", old_total_cents: OLD_TOTAL, new_total_cents: OLD_TOTAL, effective_due_date: D("2026-11-01"), detected_on: D("2026-10-14") }, BK13A);
  assert.equal(none.change_kind, null); assert.equal(none.notice_required, false); assert.equal(none.status, "no_change"); assert.equal(none.decision.outcome, "no_change_no_filing");
  // through the bus: the late decrease is filed (Fannie Mae's $175 line does not cover it), effective_date_applied stays 2026-11-01 and nothing is pushed to 3.2; the decrease bills on the due date
  const h = harness("2026-10-14T14:00:00Z");
  const r = await h.fileS1("2026-10-15", { new_total_cents: 265_000n, escrow_new_cents: 59_578n, detected_on: "2026-10-14" }, { new_total_cents: 265_000n, escrow_new_cents: 59_578n, analysis: { ...ANALYSIS, escrow_new_cents: 59_578n }, notice_date: "2026-10-15" });
  const n = h.rt.store.get("bk_payment_change_notices", r.detect.notice_id as string)!.data; assert.equal(n.change_kind, "decrease"); assert.equal(n.fnma_fee_claimable, false); assert.equal(n.timely, false); assert.equal(n.effective_date_applied, "2026-11-01");
  assert.equal(h.emitted("payment.change.effective_date.pushed").length, 0);
  const eff = await h.run("bk.change.detect", { loan_id: LOAN, op: "effective", notice_id: r.detect.notice_id }, BK, "2026-11-01T12:00:00Z"); assert.equal(eff.status, "effective"); assert.equal(eff.bills_cents, 265_000n);
  // a no-change detection is a persisted decision record and an event (never a silent return); the agent cannot waive a detected change
  const skip = await h.run("bk.change.detect", { ...DETECT, effective_due_date: "2026-12-01", new_total_cents: OLD_TOTAL }); assert.equal(skip.notice_id, null); assert.equal(h.rt.store.get("bk_payment_change_decisions", skip.decision_id as string)!.data.outcome, "no_change_no_filing");
  assert.equal(h.emitted("bankruptcy.payment_change_notice.created").filter((e) => e.payload.in_scope === true && e.payload.notice_required === false).length, 1);
  await h.refused("bk.change.detect", { ...DETECT, effective_due_date: "2027-01-01", waive_filing: true }, "CANNOT_WAIVE_DETECTED_CHANGE");
});
test("14.2-T4: Given fee items of $1,550 (2026-10-20) and $20 + $20, then a 410S-2 is filed by 2027-01-15 (aggregate ≥ $200 and batch ≤ 90 days), line 5 = $1,550.00, line 7 = $40.00, and the 180-day deadline for the first item is 2027-04-19.", async () => {
  // rule 5: counsel's POC & plan review ($1,225) and 410A history ($325) rendered 2026-10-20; inspections $20 on 2026-11-05 and 2026-12-05
  const items: FeeItem[] = [{ incurred_on: D("2026-10-20"), cents: 122_500n, line: "5", recoverable: true, status: "incurred" }, { incurred_on: D("2026-10-20"), cents: 32_500n, line: "5", recoverable: true, status: "incurred" }, { incurred_on: D("2026-11-05"), cents: 2_000n, line: "7", recoverable: true, status: "incurred" }, { incurred_on: D("2026-12-05"), cents: 2_000n, line: "7", recoverable: true, status: "incurred" }];
  const b = feeBatchSchedule(items, D("2027-01-15"));
  assert.equal(b.file_now, true); assert.equal(b.reason, "aggregate ≥ $200"); assert.equal(b.aggregate_cents, 159_000n); assert.equal(b.fnma_fee_claimable, true);
  assert.equal(b.files_on, "2027-01-15"); assert.equal(daysBetween(D("2026-10-20"), b.files_on!), 87); assert.ok(daysBetween(D("2026-10-20"), b.files_on!) <= 90);
  // 2026-10-20 + 180 = 2027-04-18 (Sunday) → Monday 2027-04-19
  assert.equal(addDays(D("2026-10-20"), 180), "2027-04-18"); assert.equal(dayOfWeek(D("2027-04-18")), 0); assert.equal(noticeDeadline180(D("2026-10-20")), "2027-04-19"); assert.equal(b.preclusion_first, "2027-04-19"); assert.equal(b.before_day_180, true);
  const s2 = form410s2Lines(items, D("2027-01-15"));
  assert.deepEqual(s2.lines, [{ line_no: "5", description: "Bankruptcy/Proof of claim fees", amount_cents: 155_000n, dates_incurred: ["2026-10-20"] }, { line_no: "7", description: "Property inspection fees", amount_cents: 4_000n, dates_incurred: ["2026-11-05", "2026-12-05"] }]);
  assert.equal(s2.total_cents, 159_000n); assert.equal(s2.passed, true); assert.equal(s2.checklist.FORM410S2_TOTAL_EQ_SUM, true); assert.equal(s2.checklist.FORM410S2_DATES_PRESENT, true);
  // the registry rows: 180 calendar days from `incurred_on` with the 9006 forward roll in the engine; the batch is satisfied by the filed + served 410S-2
  const r180 = loadOverriddenRegistry().get("BK_3002_1C_FEE_NOTICE_180")!;
  assert.equal(r180.anchorField, "incurred_on"); assert.deepEqual(r180.offsetParsed, { kind: "step", n: 180, unit: "calendar_days", rollTo: "business_days_federal" }); assert.equal(computeDue(r180.offsetParsed, D("2026-10-20"), noon("2026-10-20")).dueDate, "2027-04-19");
  assert.equal(r180.satisfiedPattern!.type, "bankruptcy.fee_notice.filed_served"); assert.equal(loadOverriddenRegistry().get("SM_BK_3002_1C_BATCH_90")!.satisfiedPattern!.type, "bankruptcy.filing.filed_served");
  // through the bus: each 2.7/13.6 item is ingested (`fee.incurred_postpetition`), arming the item's 180-day deadline and — for the first un-noticed item — the 90-day batch cadence
  const h = harness("2026-10-20T14:00:00Z");
  const incur = (id: string, line: string, on: string, amount: bigint, basis: string) => h.run("bk.fee_items.read/batch", { loan_id: LOAN, case_id: CASE, op: "incur", id, line, incurred_on: on, amount_cents: amount, recoverable_basis: basis, evidence_document_id: `doc-${id}`, source_process: line === "5" ? "13.6" : "9.x" }, BK, `${on}T14:00:00Z`);
  const i1 = await incur("fee-poc-review", "5", "2026-10-20", 122_500n, "FNMA exhibit: POC & plan review $1,225; security instrument ¶9"); assert.equal(i1.first_unnoticed, true); assert.deepEqual(i1.timers, ["BK_3002_1C_FEE_NOTICE_180", "SM_BK_3002_1C_BATCH_90"]);
  const i2 = await incur("fee-410a", "5", "2026-10-20", 32_500n, "FNMA exhibit: Form 410A $325"); assert.equal(i2.first_unnoticed, false); assert.deepEqual(i2.timers, ["BK_3002_1C_FEE_NOTICE_180"]);
  await incur("fee-insp-11", "7", "2026-11-05", 2_000n, "security instrument ¶9 (property inspections)"); await incur("fee-insp-12", "7", "2026-12-05", 2_000n, "security instrument ¶9 (property inspections)");
  const fee = h.emitted("fee.incurred_postpetition"); assert.equal(fee.length, 4); assert.deepEqual(fee.map((e) => e.payload.first_unnoticed), [true, false, false, false]); assert.equal(fee[0]!.payload.notice_deadline, "2027-04-19");
  assert.deepEqual(h.inst("BK_3002_1C_FEE_NOTICE_180").map((t) => [t.anchorDate, t.dueDate, t.status]), [["2026-10-20", "2027-04-19", "armed"], ["2026-10-20", "2027-04-19", "armed"], ["2026-11-05", "2027-05-04", "armed"], ["2026-12-05", "2027-06-03", "armed"]]);
  assert.deepEqual(h.inst("SM_BK_3002_1C_BATCH_90").map((t) => [t.anchorDate, t.dueDate]), [["2026-10-20", "2027-01-19"]], "one batch cadence, anchored on the oldest item (day 90 = MLK Day 2027-01-18 → Tuesday 2027-01-19)");
  const batch = await h.run("bk.fee_items.read/batch", { loan_id: LOAN, op: "batch" }, BK, "2027-01-15T14:00:00Z"); assert.equal(batch.file_now, true); assert.equal(batch.reason, "aggregate ≥ $200"); assert.equal(batch.files_on, "2027-01-15"); assert.equal(batch.preclusion_first, "2027-04-19");
  assert.deepEqual((batch.items as { status: string }[]).map((x) => x.status), ["batched", "batched", "batched", "batched"]); assert.equal(h.emitted("bankruptcy.fee_batch.threshold_reached").length, 1);
  const pkg = await h.run("bk.notice.render", { loan_id: LOAN, case_id: CASE, form: "410S-2", served_on: "2027-01-15" }); assert.deepEqual(pkg.lines, s2.lines); assert.equal(pkg.total_cents, 159_000n); assert.deepEqual(pkg.fee_item_ids, ["fee-poc-review", "fee-410a", "fee-insp-11", "fee-insp-12"]);
  // rule 5 tie-out: a hand-edited line (wrong amount) or a partial batch never renders
  await assert.rejects(h.run("bk.notice.render", { loan_id: LOAN, form: "410S-2", items: [{ id: "fee-poc-review", line: "5", incurred_on: "2026-10-20", amount_cents: 122_600n, status: "batched" }] }), /does not tie to bk_postpetition_fee_items/);
  await assert.rejects(h.run("bk.notice.render", { loan_id: LOAN, form: "410S-2", items: [{ id: "fee-poc-review", line: "5", incurred_on: "2026-10-20", amount_cents: 122_500n, status: "batched" }] }), /FORM410S2_TOTAL_EQ_SUM.*open fee memo 159000/);
  const f = await h.run("attorney.send_package", { loan_id: LOAN, op: "hand_off", filing_type: "s2_fee_notice", package_id: pkg.package_id }); assert.deepEqual(f.fee_item_ids, pkg.fee_item_ids);
  await h.run("attorney.send_package", { loan_id: LOAN, op: "signed", filing_id: f.id, signer_id: "u-signer" }, SIGNER);
  const c = await h.run("attorney.send_package", { loan_id: LOAN, op: "confirm_filed_served", filing_id: f.id, filed_at: "2027-01-15T16:00:00Z", served_at: "2027-01-15T16:00:00Z", nef_at: "2027-01-15T16:00:00Z", nef_docket_no: "51", certificate_of_service_document_id: "doc-cos-s2", service: CM_ECF_SERVICE, mail_manifest_id: "mm-s2", mail_manifest_date: "2027-01-15" }, BK, "2027-01-15T17:00:00Z");
  assert.equal(c.challenge_deadline, "2028-01-18"); assert.equal(h.rt.store.get("bk_postpetition_fee_items", "fee-poc-review")!.data.status, "noticed");
  assert.ok(h.inst("BK_3002_1C_FEE_NOTICE_180").every((t) => t.status === "satisfied"), "the filed + served 410S-2 satisfies every item's 180-day deadline"); assert.equal(h.inst("SM_BK_3002_1C_BATCH_90")[0]!.status, "satisfied");
  assert.equal(h.last("FRBP_3002_1E_FEE_CHALLENGE_365").dueDate, "2028-01-18");
  // once noticed, the items are never itemized again (a later 410S-2 for the same loan has no open items)
  await assert.rejects(h.run("bk.notice.render", { loan_id: LOAN, form: "410S-2" }), /no open recoverable fee items/);
});
test("14.2-T5: Given a $60 inspection-only batch with no other items, then the batch waits until day 90 and files then (before day 180) even though Fannie Mae's fee is not claimable.", async () => {
  // rule 5: two inspections at $30 (or one $60 item) on line 7 — aggregate < $200, so no Fannie Mae fee; the rule still requires the notice
  const items: FeeItem[] = [{ incurred_on: D("2026-10-20"), cents: 3_000n, line: "7", recoverable: true, status: "incurred" }, { incurred_on: D("2026-11-20"), cents: 3_000n, line: "7", recoverable: true, status: "incurred" }];
  const waiting = feeBatchSchedule(items, D("2027-01-10"));
  assert.equal(waiting.file_now, false); assert.equal(waiting.filing_required, true); assert.equal(waiting.aggregate_cents, 6_000n); assert.equal(waiting.fnma_fee_claimable, false);
  // day 90 = 2027-01-18 is the Birthday of Martin Luther King, Jr. (court closed) → the batch files the next court day, Tuesday 2027-01-19, still 90 days before the 180-day preclusion (spec: "files then" — day 90 itself is a legal holiday)
  assert.equal(addDays(D("2026-10-20"), 90), "2027-01-18"); assert.equal(isFederalHoliday(D("2027-01-18")), true);
  assert.equal(waiting.files_on, "2027-01-19"); assert.equal(daysBetween(D("2026-10-20"), waiting.files_on!), 91);
  const day90 = feeBatchSchedule(items, D("2027-01-18"));
  assert.equal(day90.file_now, true); assert.equal(day90.reason, "oldest item day 90"); assert.equal(day90.files_on, "2027-01-19");
  assert.equal(day90.preclusion_first, "2027-04-19"); assert.equal(day90.before_day_180, true); assert.equal(day90.fnma_fee_claimable, false);
  // a batch looked at after day 90 files today, never on a past date
  assert.equal(feeBatchSchedule(items, D("2027-02-10")).files_on, "2027-02-10");
  const s2 = form410s2Lines(items); assert.equal(s2.lines.length, 1); assert.equal(s2.lines[0]!.line_no, "7"); assert.equal(s2.lines[0]!.amount_cents, 6_000n); assert.deepEqual(s2.lines[0]!.dates_incurred, ["2026-10-20", "2026-11-20"]); assert.equal(s2.passed, true);
  assert.equal(feeBatchSchedule([], D("2027-01-18")).filing_required, false);
  // the internal cadence row carries the same roll as the filing: due Tuesday 2027-01-19, so the day-90 filing is on time, not late
  const row = loadOverriddenRegistry().get("SM_BK_3002_1C_BATCH_90")!; assert.deepEqual(row.offsetParsed, { kind: "step", n: 90, unit: "calendar_days", rollTo: "business_days_federal" }); assert.match(row.overrideWhy!, /Martin Luther King/);
  const h = harness("2026-10-20T14:00:00Z");
  await h.run("bk.fee_items.read/batch", { loan_id: LOAN, case_id: CASE, op: "incur", id: "insp-1", line: "7", incurred_on: "2026-10-20", amount_cents: 3_000n, recoverable_basis: "security instrument ¶9", evidence_document_id: "doc-insp-1" });
  await h.run("bk.fee_items.read/batch", { loan_id: LOAN, case_id: CASE, op: "incur", id: "insp-2", line: "7", incurred_on: "2026-11-20", amount_cents: 3_000n, recoverable_basis: "security instrument ¶9", evidence_document_id: "doc-insp-2" }, BK, "2026-11-20T14:00:00Z");
  const cadence = h.last("SM_BK_3002_1C_BATCH_90"); assert.equal(cadence.anchorDate, "2026-10-20"); assert.equal(cadence.dueDate, "2027-01-19"); assert.equal(h.inst("SM_BK_3002_1C_BATCH_90").length, 1);
  const w = await h.run("bk.fee_items.read/batch", { loan_id: LOAN, op: "batch" }, BK, "2027-01-10T14:00:00Z"); assert.equal(w.file_now, false); assert.equal(w.files_on, "2027-01-19"); assert.equal(h.emitted("bankruptcy.fee_batch.threshold_reached").length, 0);
  const d90 = await h.run("bk.fee_items.read/batch", { loan_id: LOAN, op: "batch" }, BK, "2027-01-18T14:00:00Z"); assert.equal(d90.file_now, true); assert.equal(d90.reason, "oldest item day 90"); assert.equal(d90.fnma_fee_claimable, false);
  const pkg = await h.run("bk.notice.render", { loan_id: LOAN, form: "410S-2", served_on: "2027-01-19" }, BK, "2027-01-19T14:00:00Z"); assert.equal(pkg.total_cents, 6_000n);
  const f = await h.run("attorney.send_package", { loan_id: LOAN, op: "hand_off", filing_type: "s2_fee_notice", package_id: pkg.package_id }); await h.run("attorney.send_package", { loan_id: LOAN, op: "signed", filing_id: f.id, signer_id: "u-signer" }, SIGNER);
  assert.equal(h.timers.evaluate("2027-01-19T20:00:00Z").length, 0, "nothing breaches on the rolled day-90");
  await h.run("attorney.send_package", { loan_id: LOAN, op: "confirm_filed_served", filing_id: f.id, filed_at: "2027-01-19T16:00:00Z", served_at: "2027-01-19T16:00:00Z", nef_at: "2027-01-19T16:00:00Z", nef_docket_no: "52", certificate_of_service_document_id: "doc-cos", service: CM_ECF_SERVICE, mail_manifest_id: "mm", mail_manifest_date: "2027-01-19" }, BK, "2027-01-19T17:00:00Z");
  assert.equal(cadence.status, "satisfied"); assert.equal(cadence.satisfiedAt, "2027-01-19T17:00:00Z"); assert.ok(h.inst("BK_3002_1C_FEE_NOTICE_180").every((t) => t.status === "satisfied"));
});
test("14.2-T6: Given an item not noticed by day 180, then its status is `precluded_not_noticed`, it is written off, and no later statement or payoff includes it.", async () => {
  const items: PostpetitionFeeItem[] = [
    { id: "fee-insp-2026-10-20", line: "7", incurred_on: D("2026-10-20"), cents: 2_000n, recoverable: true, status: "incurred" },
    { id: "fee-poc-2027-01", line: "5", incurred_on: D("2027-01-05"), cents: 155_000n, recoverable: true, status: "noticed" },
    { id: "fee-atty-2026-08", line: "3", incurred_on: D("2026-08-01"), cents: 40_000n, recoverable: true, status: "allowed_by_lapse" },
  ];
  // day 180 for the 2026-10-20 inspection is Monday 2027-04-19 (rolled from Sunday 04-18); on 2027-04-20 it has passed un-noticed
  assert.equal(precludeAndWriteOff(items, D("2027-04-19")).precluded.length, 0);
  const r = precludeAndWriteOff(items, D("2027-04-20"));
  assert.deepEqual(r.precluded.map((i) => [i.id, i.status]), [["fee-insp-2026-10-20", "precluded_not_noticed"]]); assert.equal(items[0]!.status, "incurred", "append-only: the input row is not mutated");
  assert.equal(r.write_off_cents, 2_000n); assert.equal(r.balanced, true); assert.equal(r.severity, 2); assert.equal(r.timer, "BK_3002_1C_FEE_NOTICE_180");
  assert.deepEqual(r.postings.map((p) => [p.account, p.debit, p.credit]), [["bk_fee_expense", 2_000n, 0n], ["bk_postpetition_fee_memo", 0n, 2_000n]]); assert.ok(r.postings.every((p) => /Rule 3002\.1\((c|h)\)/.test(p.rule_ref) || /exposure memo/.test(p.rule_ref)));
  // no later statement or payoff includes it: only allowed items reach the receivable; the precluded $20 is excluded
  const c = collectibleFees(r.items);
  assert.equal(c.allowed_noticed_fees_unpaid_cents, 40_000n); assert.equal(c.payoff_fees_cents, 40_000n); assert.equal(c.memo_only_cents, 155_000n); assert.deepEqual(c.excluded, [{ id: "fee-insp-2026-10-20", status: "precluded_not_noticed", cents: 2_000n }]);
  const stmt = ch13Content({ statement_date: D("2027-05-17"), postpetition_installment_cents: NEW_TOTAL, postpetition_unpaid: [], allowed_noticed_fees_unpaid_cents: c.allowed_noticed_fees_unpaid_cents, suspense_cents: 0n, prepetition_arrearage_cents: 1_424_194n, trustee_pays_postpetition: false });
  assert.equal(stmt.amount_due_cents, NEW_TOTAL + 40_000n);
  // escalations: write-offs above $1,000 per case (cumulative) and every late-notice attempt are the officer's
  assert.equal(r.officer_required, false); assert.equal(r.officer_threshold_cents, 100_000n); assert.deepEqual(r.late_notice_attempt, { requires_role: "officer", requires: "counsel_advice_document_id", otherwise: "waived" });
  assert.equal(precludeAndWriteOff(items, D("2027-04-20"), { case_written_off_to_date_cents: 98_000n }).case_write_off_total_cents, 100_000n); assert.equal(precludeAndWriteOff(items, D("2027-04-20"), { case_written_off_to_date_cents: 98_000n }).officer_required, false);
  assert.equal(precludeAndWriteOff(items, D("2027-04-20"), { case_written_off_to_date_cents: 99_000n }).officer_required, true);
  const big = precludeAndWriteOff([{ id: "fee-atty-2026-10", line: "3", incurred_on: D("2026-10-20"), cents: 122_500n, recoverable: true, status: "batched" }], D("2027-04-20"));
  assert.equal(big.write_off_cents, 122_500n); assert.equal(big.officer_required, true);
  // through the bus: the item's 180-day timer breaches (sev-2) on 2027-04-20, the item is precluded and written off, a later 410S-2 cannot carry it, and a late-notice attempt is the officer's alone
  const h = harness("2026-10-20T14:00:00Z");
  await h.run("bk.fee_items.read/batch", { loan_id: LOAN, case_id: CASE, op: "incur", id: "fee-insp-2026-10-20", line: "7", incurred_on: "2026-10-20", amount_cents: 2_000n, recoverable_basis: "security instrument ¶9", evidence_document_id: "doc-insp" });
  const t180 = h.last("BK_3002_1C_FEE_NOTICE_180"); assert.equal(t180.dueDate, "2027-04-19");
  assert.deepEqual(h.timers.evaluate("2027-04-19T20:00:00Z").map((b) => b.instance.code).filter((c) => c === "BK_3002_1C_FEE_NOTICE_180"), [], "the 180-day clock has not matured on day 179 (the un-batched item's 90-day batch clock lapsed earlier)"); const breaches = h.timers.evaluate("2027-04-20T12:00:00Z"); assert.deepEqual(breaches.map((b) => [b.instance.code, b.severity]), [["BK_3002_1C_FEE_NOTICE_180", 2]]);
  const p = await h.run("bk.fee_items.read/batch", { loan_id: LOAN, op: "preclude" }, BK, "2027-04-20T14:00:00Z");
  assert.deepEqual((p.precluded as { id: string }[]).map((x) => x.id), ["fee-insp-2026-10-20"]); assert.equal(p.write_off_cents, 2_000n); assert.equal(h.rt.store.get("bk_postpetition_fee_items", "fee-insp-2026-10-20")!.data.status, "precluded_not_noticed");
  assert.deepEqual(h.emitted("bankruptcy.fee_item.precluded").map((e) => [e.payload.fee_item_id, e.payload.written_off, e.payload.timer]), [["fee-insp-2026-10-20", true, "BK_3002_1C_FEE_NOTICE_180"]]);
  await assert.rejects(h.run("bk.notice.render", { loan_id: LOAN, form: "410S-2" }), /no open recoverable fee items/);
  assert.deepEqual((await h.run("bk.fee_items.read/batch", { loan_id: LOAN, op: "read" })).collectible, { allowed_noticed_fees_unpaid_cents: 0n, payoff_fees_cents: 0n, memo_only_cents: 0n, excluded: [{ id: "fee-insp-2026-10-20", status: "precluded_not_noticed", cents: 2_000n }] });
  await h.refused("bk.fee_items.read/batch", { loan_id: LOAN, op: "late_notice_attempt", item_ids: ["fee-insp-2026-10-20"], counsel_advice_document_id: "doc-counsel" }, "OFFICER_LATE_NOTICE_ATTEMPT");
  const late = await h.run("bk.fee_items.read/batch", { loan_id: LOAN, op: "late_notice_attempt", item_ids: ["fee-insp-2026-10-20"], counsel_advice_document_id: "doc-counsel" }, OFFICER); assert.equal(late.requires_officer, true); assert.equal(h.rt.store.get("bk_postpetition_fee_items", "fee-insp-2026-10-20")!.data.status, "batched");
});
test("14.2-T7: Given a Form 410C13-M1 served by CM/ECF on Friday 2028-03-03, then the response deadline is Friday 2028-03-31; served by mail, Monday 2028-04-03.", async () => {
  assert.equal(dayOfWeek(D("2028-03-03")), 5);
  assert.equal(responseDue(D("2028-03-03"), false), "2028-03-31"); assert.equal(dayOfWeek(D("2028-03-31")), 5);
  assert.equal(responseDue(D("2028-03-03"), true), "2028-04-03"); assert.equal(dayOfWeek(D("2028-04-03")), 1);   // +28 +3 (9006(f)) = Monday
  // rule 6: the M1R computed from the ledger as of the motion's stated date, compared with the motion's facts at $0.00 tolerance
  const paid = (due: string) => ({ due: D(due), amount_cents: NEW_TOTAL, paid_cents: NEW_TOTAL, received_on: addDays(D(due), 1) });
  const base = { served_on: D("2028-03-03"), by_mail: false, arrearage_cents: 700_000n, postpetition: [paid("2028-01-01"), paid("2028-02-01"), paid("2028-03-01")], unpaid_noticed_fees_cents: 0n, amortization: BK13A_NOTE, escrow_monthly_cents: ESCROW_NEW, deferred_interest_cents: 0n, escrow_balance_cents: 90_000n, unapplied_cents: 0n, history: [{ due: "2028-03-01", received_on: "2028-03-02", amount_cents: NEW_TOTAL }] };
  const m1r = form410c13m1r({ ...base, stated_facts: { prepetition_cured: false, prepetition_remaining_cents: 700_000n, postpetition_current: true } });
  assert.equal(m1r.form, "410C13-M1R"); assert.equal(m1r.responds_to, "410C13-M1"); assert.equal(m1r.response_due, "2028-03-31"); assert.equal(m1r.filed_as, "response_to_motion");
  assert.equal(m1r.agree, true); assert.deepEqual(m1r.disagreements, []); assert.equal(m1r.fnma_fee_cents, 12_500n); assert.equal(m1r.fnma_fee_line, "Response to Motion to Determine Status");
  assert.equal(m1r.part2.statement, "amount remaining"); assert.equal(m1r.part2.remaining_cents, 700_000n); assert.equal(m1r.part3.statement, "current"); assert.equal(m1r.part3.next_due_date, "2028-04-01"); assert.equal(m1r.part3.next_due_cents, NEW_TOTAL); assert.equal(m1r.part3.last_payment_received_on, "2028-03-02");
  assert.equal(m1r.part4_history!.length, 1, "Part 4 attached: the response asserts an uncured prepetition arrearage"); assert.equal(m1r.precludes_later_default_claim, false);
  assert.equal(form410c13m1r({ ...base, by_mail: true, stated_facts: { prepetition_cured: false, prepetition_remaining_cents: 700_000n, postpetition_current: true } }).response_due, "2028-04-03");
  // a one-cent variance in the motion's figures is a disagreement → itemized, history attached, $625
  const off = form410c13m1r({ ...base, stated_facts: { prepetition_cured: false, prepetition_remaining_cents: 699_999n, postpetition_current: true } });
  assert.equal(off.agree, false); assert.equal(off.disagreements.length, 1); assert.match(off.disagreements[0]!, /\$6,999\.99 ≠ ledger \$7,000\.00/); assert.equal(off.fnma_fee_cents, 62_500n); assert.equal(off.checklist.FORM410C13NR_PART4_REQUIRED_IF_DISAGREE, true);
  // the registry row: anchored on the served date, 28 calendar days rolled forward in the engine, satisfied by the filed + served M1R
  const row = loadOverriddenRegistry().get("FRBP_3002_1F_STATUS_RESPONSE_28")!;
  assert.equal(row.anchorField, "served_at"); assert.deepEqual(row.offsetParsed, { kind: "step", n: 28, unit: "calendar_days", rollTo: "business_days_federal" }); assert.equal(computeDue(row.offsetParsed, D("2028-03-03"), noon("2028-03-03")).dueDate, "2028-03-31");
  assert.equal(row.satisfiedPattern!.type, "bankruptcy.filing.filed_served"); assert.match(row.trigger, /motion_410c13_m1/); assert.match(row.overrideWhy!, /9006\(f\)/);
  // through the bus: the docketed motion (14.1 monitor) arms the engine's clock on 2028-03-31; op=trigger opens the response with the same deadline (Monday 2028-04-03 by mail); the filed + served M1R satisfies it
  const h = harness("2028-03-03T18:00:00Z");
  h.events.append(docket("motion_410c13_m1", { served_at: "2028-03-03", service_method: "cm_ecf", docket_no: "88" })); assert.equal(h.last("FRBP_3002_1F_STATUS_RESPONSE_28").dueDate, "2028-03-31");
  const t = await h.run("bk.status_response.compute", { loan_id: LOAN, case_id: CASE, op: "trigger", kind: "motion_410c13_m1", served_on: "2028-03-03", docket_event_id: "dk-88" });
  assert.equal(t.kind, "m1r"); assert.equal(t.response_deadline, "2028-03-31"); assert.equal(t.timer, "FRBP_3002_1F_STATUS_RESPONSE_28"); assert.equal(t.status, "triggered"); assert.equal(t.service_method, "cm_ecf");
  assert.equal((await h.run("bk.status_response.compute", { loan_id: LOAN, op: "trigger", kind: "motion_410c13_m1", served_on: "2028-03-03", by_mail: true, id: "sr-mail" })).response_deadline, "2028-04-03");
  const r = await h.run("bk.status_response.compute", { loan_id: LOAN, case_id: CASE, kind: "m1r", served_on: "2028-03-03", arrearage_cents: 700_000n, postpetition: base.postpetition, unpaid_noticed_fees_cents: 0n, amortization: BK13A_NOTE, escrow_monthly_cents: ESCROW_NEW, deferred_interest_cents: 0n, escrow_balance_cents: 90_000n, unapplied_cents: 0n, history: base.history, stated_facts: { prepetition_cured: false, prepetition_remaining_cents: 700_000n, postpetition_current: true } });
  assert.equal(r.response_id, t.response_id); assert.equal(r.agree, true); assert.equal(h.rt.store.get("bk_status_responses", t.response_id as string)!.data.status, "computed");
  const f = await h.run("attorney.send_package", { loan_id: LOAN, op: "hand_off", filing_type: "m1r_status_response", package_id: "pkg-m1r", response_id: t.response_id }); await h.run("attorney.send_package", { loan_id: LOAN, op: "signed", filing_id: f.id, signer_id: "u-signer" }, SIGNER);
  await h.run("attorney.send_package", { loan_id: LOAN, op: "confirm_filed_served", filing_id: f.id, filed_at: "2028-03-29T16:00:00Z", served_at: "2028-03-29T16:00:00Z", nef_at: "2028-03-29T16:00:00Z", nef_docket_no: "91", certificate_of_service_document_id: "doc-cos", service: CM_ECF_SERVICE, mail_manifest_id: "mm", mail_manifest_date: "2028-03-29" }, BK, "2028-03-29T17:00:00Z");
  assert.equal(h.last("FRBP_3002_1F_STATUS_RESPONSE_28").status, "satisfied"); assert.equal(h.rt.store.get("bk_status_responses", t.response_id as string)!.data.status, "filed_served");
});
test("14.2-T8: Given the trustee's 410C13-N served electronically 2031-06-20 and the ledgers show arrearage 0 and all post-petition installments through 2031-06-01 paid, then the 410C13-NR states cured/current, shows UPB $288,625.18 and next due 2031-07-01, and is filed as a POC supplement by 2031-07-18.", async () => {
  assert.equal(dayOfWeek(D("2031-06-20")), 5);
  const rows = ["2031-04-01", "2031-05-01", "2031-06-01"].map((due) => ({ due: D(due), amount_cents: PI + ESCROW_NEW, paid_cents: PI + ESCROW_NEW, received_on: addDays(D(due), 2) }));
  const nr = form410c13nr({ served_on: D("2031-06-20"), by_mail: false, arrearage_cents: 0n, postpetition: rows, unpaid_noticed_fees_cents: 0n, stated_facts: { prepetition_cured: true, cure_disbursed_cents: 1_424_194n, postpetition_current: true }, cure_received_cents: 1_424_194n, amortization: BK13A_NOTE, escrow_monthly_cents: ESCROW_NEW, deferred_interest_cents: 0n, escrow_balance_cents: 150_000n, unapplied_cents: 0n, history: [] });
  assert.equal(nr.form, "410C13-NR"); assert.equal(nr.responds_to, "410C13-N"); assert.equal(nr.part2.statement, "paid in full"); assert.equal(nr.part2.prepetition_cured, true); assert.equal(nr.part3.statement, "current"); assert.equal(nr.part3.first_unpaid_postpetition_due, null);
  // Part 3 from the ledger views: the 2031-06-01 installment is payment #95 of the $325,000 / 6.500% / 360 note (first due 2023-08-01) → UPB $288,625.18; next due 2031-07-01 at P&I $2,054.22 + then-current escrow $752.50
  assert.equal(nr.part3.source, "ledger_views"); assert.equal(nr.part3.installments_paid, 95); assert.equal(nr.part3.upb_after_installment, "2031-06-01"); assert.equal(nr.part3.upb_cents, 28_862_518n); assert.equal(nr.part3.upb_cents, balanceAfter(32_500_000n, "6.500", 360, 95));
  assert.equal(nr.part3.pi_cents, 205_422n); assert.equal(nr.part3.next_due_date, "2031-07-01"); assert.equal(nr.part3.next_due_cents, 280_672n); assert.equal(nr.part3.last_payment_received_on, "2031-06-03"); assert.equal(nr.part3.deferred_interest_cents, 0n); assert.equal(nr.part3.escrow_balance_cents, 150_000n);
  assert.equal(nr.filed_as, "supplement_to_proof_of_claim"); assert.equal(nr.checklist.FORM410C13NR_SUPPLEMENT_TO_CLAIM, true); assert.equal(nr.response_due, "2031-07-18"); assert.equal(dayOfWeek(D("2031-07-18")), 5); assert.deepEqual(nr.service, ["debtor", "debtor_attorney", "trustee"]);
  assert.equal(nr.agree, true); assert.equal(nr.fnma_fee_cents, 12_500n); assert.equal(nr.fnma_fee_line, "Response to Trustee's Notice of Disbursements Made"); assert.equal(nr.precludes_later_default_claim, true); assert.equal(nr.part4_history, null); assert.equal(g4MotionWindow(nr.part3.statement, D("2031-07-15")).starts, false);
  // served by mail → Monday 2031-07-21 (+3 under 9006(f))
  assert.equal(form410c13nr({ served_on: D("2031-06-20"), by_mail: true, arrearage_cents: 0n, postpetition: rows, unpaid_noticed_fees_cents: 0n, amortization: BK13A_NOTE, escrow_monthly_cents: ESCROW_NEW, deferred_interest_cents: 0n, escrow_balance_cents: 150_000n, unapplied_cents: 0n, history: [] }).response_due, "2031-07-21");
  // the trustee's own statement of "not current" with our figures is still an agreed response; a mismatched cure disbursement is not
  assert.equal(form410c13nr({ served_on: D("2031-06-20"), by_mail: false, arrearage_cents: 0n, postpetition: rows, unpaid_noticed_fees_cents: 0n, stated_facts: { prepetition_cured: true, cure_disbursed_cents: 1_424_193n, postpetition_current: true }, cure_received_cents: 1_424_194n, amortization: BK13A_NOTE, escrow_monthly_cents: ESCROW_NEW, deferred_interest_cents: 0n, escrow_balance_cents: 150_000n, unapplied_cents: 0n, history: [{ due: "2031-06-01" }] }).agree, false);
  // a skipped installment before the last paid one is not "paid": 2031-04-01 unpaid, 05 and 06 paid → 94 installments, UPB after #94, first unpaid 2031-04-01
  const skipped = form410c13nr({ served_on: D("2031-06-20"), by_mail: false, arrearage_cents: 0n, postpetition: rows.map((r) => (r.due === "2031-04-01" ? { ...r, paid_cents: 0n } : r)), unpaid_noticed_fees_cents: 0n, amortization: BK13A_NOTE, escrow_monthly_cents: ESCROW_NEW, deferred_interest_cents: 0n, escrow_balance_cents: 150_000n, unapplied_cents: 0n, history: [{ due: "2031-04-01", received_on: null, amount_cents: 0n }] });
  assert.equal(skipped.part3.statement, "not current"); assert.equal(skipped.part3.first_unpaid_postpetition_due, "2031-04-01"); assert.equal(skipped.part3.installments_paid, 94); assert.equal(skipped.part3.upb_cents, balanceAfter(32_500_000n, "6.500", 360, 94)); assert.ok(skipped.part3.upb_cents > 28_862_518n);
  // the registry row and the rendered form
  const row = loadOverriddenRegistry().get("FRBP_3002_1G3_FINAL_CURE_RESPONSE_28")!;
  assert.equal(row.anchorField, "served_at"); assert.equal(computeDue(row.offsetParsed, D("2031-06-20"), noon("2031-06-20")).dueDate, "2031-07-18"); assert.equal(row.satisfiedPattern!.type, "bankruptcy.filing.filed_served"); assert.match(row.satisfied, /nr_final_cure_response/);
  const doc = renderCourtForm("CRT_B410C13_NR", { creditor_name: "Fannie Mae (Supermortgage, servicer)", claim_no: "7", account_last4: "4821", response: nr, signer_role: "authorized_agent", signer_name: "S. Officer", signed_on: "2031-07-10" });
  assert.equal(doc.blocked, false); assert.match(doc.text, /filed as a supplement to the claim holder's proof of claim/); assert.match(doc.text, /The amount required to cure any prepetition arrearage has been paid in full/); assert.match(doc.text, /The debtor is current on all postpetition payments, including all fees, charges, expenses, escrow, and costs/); assert.match(doc.text, /Unpaid principal balance: \$288,625\.18/); assert.match(doc.text, /Next payment due 2031-07-01: \$2,806\.72/);
  // through the bus: the trustee's final voucher (2031-05-20) freezes the ledger views and starts the 45-day watch; the docketed 410C13-N satisfies the watch and arms the 28-day response; the NR is computed from the frozen views (hand-entered rows that differ are refused), filed as a POC supplement and served by 2031-07-18
  const h = harness("2031-05-20T14:00:00Z"); h.rt.store.put("bankruptcy_ledger_views", "lv-2031-05", ledgerView(["2031-04-01", "2031-05-01", "2031-06-01"]), BK, "2031-06-03T12:00:00Z");
  const fz = await h.run("bk.status_response.compute", { loan_id: LOAN, case_id: CASE, op: "plan_completed", completed_on: "2031-05-20", source: "final_voucher", final_voucher_id: "TFS-9981", trustee_id: "T-13-NDCA" }, BK, "2031-06-03T12:00:00Z");
  assert.equal(fz.event, "bankruptcy.plan.completed"); assert.match(fz.ledger_snapshot_hash as string, /^[0-9a-f]{64}$/); assert.equal(fz.watch.lapses_on, "2031-07-04");
  const watch = h.last("SM_BK_3002_1G1_TRUSTEE_NOTICE_WATCH_45"); assert.equal(watch.anchorDate, "2031-05-20"); assert.equal(watch.dueDate, "2031-07-04"); assert.equal(watch.status, "armed");
  h.clock.set("2031-06-20T18:00:00Z"); h.events.append(docket("trustee_notice_410c13_n", { served_at: "2031-06-20", service_method: "cm_ecf", docket_no: "120", notice_date: "2031-06-20", cure_disbursed_cents: 1_424_194n }));
  assert.equal(watch.status, "satisfied"); assert.equal(h.last("FRBP_3002_1G3_FINAL_CURE_RESPONSE_28").dueDate, "2031-07-18");
  const t = await h.run("bk.status_response.compute", { loan_id: LOAN, case_id: CASE, op: "trigger", kind: "trustee_notice_410c13_n", served_on: "2031-06-20", docket_event_id: "dk-120" }); assert.equal(t.frozen_view_id, fz.frozen_view_id); assert.equal(t.response_deadline, "2031-07-18"); assert.equal(t.filing_type, "nr_final_cure_response");
  await assert.rejects(h.run("bk.status_response.compute", { loan_id: LOAN, case_id: CASE, kind: "nr", served_on: "2031-06-20", postpetition: rows.map((r) => ({ ...r, paid_cents: r.paid_cents + 1n })) }), /do not tie to the frozen ledger view/);
  const r = await h.run("bk.status_response.compute", { loan_id: LOAN, case_id: CASE, kind: "nr", served_on: "2031-06-20", stated_facts: { prepetition_cured: true, cure_disbursed_cents: 1_424_194n, postpetition_current: true } });
  assert.equal(r.response_id, t.response_id); assert.equal(r.part2.statement, "paid in full"); assert.equal(r.part3.statement, "current"); assert.equal(r.part3.upb_cents, 28_862_518n); assert.equal(r.part3.next_due_date, "2031-07-01"); assert.equal(r.part3.next_due_cents, 280_672n); assert.equal(r.agree, true); assert.equal(r.filed_as, "supplement_to_proof_of_claim"); assert.equal(r.ledger_snapshot_hash, fz.ledger_snapshot_hash); assert.equal(r.response_due, "2031-07-18");
  const docTool = await h.run("documents.render", { loan_id: LOAN, template_code: "CRT_B410C13_NR", payload: { creditor_name: "Fannie Mae (Supermortgage, servicer)", claim_no: "7", account_last4: "4821", response: r, signer_role: "authorized_agent", signer_name: "S. Officer", signed_on: "2031-07-10" } }, BK, "2031-07-10T14:00:00Z"); assert.equal(docTool.retention, "court_record_7y");
  const f = await h.run("attorney.send_package", { loan_id: LOAN, op: "hand_off", filing_type: "nr_final_cure_response", package_id: "pkg-nr", response_id: t.response_id }); await h.run("attorney.send_package", { loan_id: LOAN, op: "signed", filing_id: f.id, signer_id: "u-signer" }, SIGNER);
  const c = await h.run("attorney.send_package", { loan_id: LOAN, op: "confirm_filed_served", filing_id: f.id, filed_at: "2031-07-15T16:00:00Z", served_at: "2031-07-15T16:00:00Z", nef_at: "2031-07-15T16:00:00Z", nef_docket_no: "131", certificate_of_service_document_id: "doc-cos", service: CM_ECF_SERVICE, mail_manifest_id: "mm", mail_manifest_date: "2031-07-15" }, BK, "2031-07-15T17:00:00Z");
  assert.equal(c.statement, "current"); assert.equal(h.last("FRBP_3002_1G3_FINAL_CURE_RESPONSE_28").status, "satisfied"); assert.equal(h.emitted("bankruptcy.form_410c13nr.served")[0]!.payload.statement, "current"); assert.equal(h.inst("FRBP_3002_1G4_DEBTOR_MOTION_WINDOW_45").length, 0, "an agree/current response ends the bankruptcy accounting: no (g)(4) window");
});
test(`14.2-T9: Given the same notice but the 2031-06-01 installment unpaid, then the response states "not current," itemizes 2031-06-01 with its amount, attaches the Part 4 history, and the (g)(4) window timer starts on service.`, async () => {
  const history = [{ due: "2031-05-01", received_on: "2031-05-03", amount_cents: 280_672n }, { due: "2031-06-01", received_on: null, amount_cents: 0n }];
  const base = { served_on: D("2031-06-20"), by_mail: false, arrearage_cents: 0n, unpaid_noticed_fees_cents: 0n, last_payment_received_on: D("2031-05-03"), next_due: D("2031-07-01"), next_due_cents: 280_672n, upb_cents: 28_862_518n, deferred_interest_cents: 0n, escrow_balance_cents: 150_000n, unapplied_cents: 0n, history };
  const paid = (due: string) => ({ due: D(due), amount_cents: 280_672n, paid_cents: 280_672n });
  const current = form410c13nr({ ...base, postpetition: [paid("2031-05-01"), paid("2031-06-01")] });
  assert.equal(current.part3.statement, "current"); assert.equal(current.part4_history, null); assert.equal(g4MotionWindow(current.part3.statement, D("2031-07-15")).starts, false);
  const r = form410c13nr({ ...base, postpetition: [paid("2031-05-01"), { due: D("2031-06-01"), amount_cents: 280_672n, paid_cents: 0n }] });
  assert.equal(r.part3.statement, "not current"); assert.equal(r.part3.first_unpaid_postpetition_due, "2031-06-01");
  assert.deepEqual(r.part3.itemization, [{ due: "2031-06-01", amount_cents: 280_672n }]);
  assert.deepEqual(r.part4_history, history); assert.equal(r.checklist.FORM410C13NR_PART4_REQUIRED_IF_DISAGREE, true); assert.equal(r.filed_as, "supplement_to_proof_of_claim");
  // the trustee's notice asserts "current" (default stated facts) → the ledger disagrees → $625 with the history attached
  assert.equal(r.agree, false); assert.match(r.disagreements[0]!, /is current; the ledger shows first unpaid 2031-06-01/); assert.equal(r.fnma_fee_cents, 62_500n); assert.equal(r.response_due, "2031-07-18"); assert.equal(r.precludes_later_default_claim, false);
  // the trustee's notice itself stating "not current" from 2031-06-01 is an agreed ($125) "not current" response — the ledger, not the label, decides the statement
  const agreed = form410c13nr({ ...base, postpetition: [paid("2031-05-01"), { due: D("2031-06-01"), amount_cents: 280_672n, paid_cents: 0n }], stated_facts: { prepetition_cured: true, postpetition_current: false, first_unpaid_postpetition_due: D("2031-06-01") } });
  assert.equal(agreed.part3.statement, "not current"); assert.equal(agreed.agree, true); assert.equal(agreed.fnma_fee_cents, 12_500n); assert.ok(agreed.part4_history, "Part 4 still attached: the response asserts post-petition non-payment");
  // the (g)(4) window runs 45 days from service of the response
  const g4 = g4MotionWindow(r.part3.statement, D("2031-07-15"));
  assert.equal(g4.starts, true); assert.equal(g4.timer, "FRBP_3002_1G4_DEBTOR_MOTION_WINDOW_45"); assert.equal(g4.anchor, "served_at"); assert.equal(g4.starts_on, "2031-07-15"); assert.equal(g4.lapses_on, "2031-08-29"); assert.equal(g4.post_case_collectible, "itemized_amounts_only");
  const row = loadOverriddenRegistry().get("FRBP_3002_1G4_DEBTOR_MOTION_WINDOW_45")!; assert.match(row.trigger, /form_410c13nr\.served/); assert.equal(row.anchorField, "served_at");
  assert.equal(computeDue(row.offsetParsed, D("2031-07-15"), noon("2031-07-15")).dueDate, "2031-08-29"); assert.equal(row.satisfiedPattern!.type, "bankruptcy.docket.event.received"); assert.match(row.satisfied, /motion_410c13_m2/);
  // the truthful "not current" form renders (the Official Form's alternative statement) with the Part 4 history attached; a disagreeing response without its history is blocked
  const doc = renderCourtForm("CRT_B410C13_NR", { creditor_name: "Fannie Mae (Supermortgage, servicer)", claim_no: "7", account_last4: "4821", response: r, signer_role: "authorized_agent", signer_name: "S. Officer", signed_on: "2031-07-10" });
  assert.equal(doc.blocked, false); assert.match(doc.text, /The debtor is not current; the debtor first became delinquent on 2031-06-01: 2031-06-01 \$2,806\.72\./); assert.match(doc.text, /Part 4: Itemized Payment History\. Attached \(2 entries\)\./); assert.match(doc.text, /Disputed facts: Part 3/);
  const noHistory = renderCourtForm("CRT_B410C13_NR", { creditor_name: "Fannie Mae (Supermortgage, servicer)", claim_no: "7", account_last4: "4821", response: { ...r, part4_history: [] }, signer_role: "authorized_agent", signer_name: "S. Officer", signed_on: "2031-07-10" }); assert.equal(noHistory.blocked, true); assert.deepEqual(noHistory.failed, ["FORM410C13NR_PART4_REQUIRED_IF_DISAGREE"]);
  // through the bus: the frozen view carries the unpaid 2031-06-01 installment; the NR is computed from it (a hand-entered "current" is refused), rendered, filed and served 2031-07-15 → `bankruptcy.form_410c13nr.served` arms the (g)(4) window on 2031-08-29; the debtor's docketed M2 satisfies it and arms the 28-day M2R response
  const h = harness("2031-06-03T12:00:00Z"); h.rt.store.put("bankruptcy_ledger_views", "lv-2031-06", ledgerView(["2031-04-01", "2031-05-01", "2031-06-01"], ["2031-06-01"]), BK, "2031-06-03T12:00:00Z");
  await h.run("bk.status_response.compute", { loan_id: LOAN, case_id: CASE, op: "plan_completed", completed_on: "2031-05-20", source: "trustee_final_report" });
  h.clock.set("2031-06-20T18:00:00Z"); h.events.append(docket("trustee_notice_410c13_n", { served_at: "2031-06-20", service_method: "cm_ecf", docket_no: "120" }));
  const t = await h.run("bk.status_response.compute", { loan_id: LOAN, case_id: CASE, op: "trigger", kind: "trustee_notice_410c13_n", served_on: "2031-06-20" });
  await h.refused("bk.status_response.compute", { loan_id: LOAN, kind: "nr", served_on: "2031-06-20", assert_current: true, postpetition: [{ due: "2031-06-01", amount_cents: 280_672n, paid_cents: 0n }] }, "CANNOT_STATE_CURRENT_WHILE_UNPAID");
  await assert.rejects(h.run("bk.status_response.compute", { loan_id: LOAN, kind: "nr", served_on: "2031-06-20", history: [] }), /FORM410C13NR_PART4_REQUIRED_IF_DISAGREE/);
  const rr = await h.run("bk.status_response.compute", { loan_id: LOAN, case_id: CASE, kind: "nr", served_on: "2031-06-20" });
  assert.equal(rr.part3.statement, "not current"); assert.deepEqual(rr.part3.itemization, [{ due: "2031-06-01", amount_cents: 280_672n }]); assert.equal(rr.part3.installments_paid, 94); assert.equal((rr.part4_history as unknown[]).length, 3); assert.equal(rr.agree, false); assert.equal(rr.fnma_fee_cents, 62_500n); assert.equal(rr.g4_window.starts, true);
  const rendered = await h.run("documents.render", { loan_id: LOAN, template_code: "CRT_B410C13_NR", payload: { creditor_name: "Fannie Mae (Supermortgage, servicer)", claim_no: "7", account_last4: "4821", response: rr, signer_role: "authorized_agent", signer_name: "S. Officer", signed_on: "2031-07-10" } }, BK, "2031-07-10T14:00:00Z"); assert.match(rendered.text as string, /not current/);
  const f = await h.run("attorney.send_package", { loan_id: LOAN, op: "hand_off", filing_type: "nr_final_cure_response", package_id: "pkg-nr", response_id: t.response_id }); await h.run("attorney.send_package", { loan_id: LOAN, op: "signed", filing_id: f.id, signer_id: "u-signer" }, SIGNER);
  const c = await h.run("attorney.send_package", { loan_id: LOAN, op: "confirm_filed_served", filing_id: f.id, filed_at: "2031-07-15T16:00:00Z", served_at: "2031-07-15T16:00:00Z", nef_at: "2031-07-15T16:00:00Z", nef_docket_no: "131", certificate_of_service_document_id: "doc-cos", service: CM_ECF_SERVICE, mail_manifest_id: "mm", mail_manifest_date: "2031-07-15" }, BK, "2031-07-15T17:00:00Z");
  assert.equal(c.statement, "not current"); assert.equal(c.g4_window.lapses_on, "2031-08-29");
  const served = h.emitted("bankruptcy.form_410c13nr.served")[0]!; assert.equal(eventMatches(row.triggerPattern!, served), true); assert.equal(served.payload.statement, "not current");
  const win = h.last("FRBP_3002_1G4_DEBTOR_MOTION_WINDOW_45"); assert.equal(win.anchorDate, "2031-07-15"); assert.equal(win.dueDate, "2031-08-29"); assert.equal(win.status, "armed");
  h.clock.set("2031-08-10T18:00:00Z"); h.events.append(docket("motion_410c13_m2", { served_at: "2031-08-10", service_method: "cm_ecf", docket_no: "140" }));
  assert.equal(win.status, "satisfied"); assert.equal(h.last("FRBP_3002_1G4_MOTION_RESPONSE_28").dueDate, "2031-09-08");
  assert.equal((await h.run("bk.status_response.compute", { loan_id: LOAN, op: "trigger", kind: "motion_410c13_m2", served_on: "2031-08-10" })).response_deadline, "2031-09-08");
});
test("14.2-T10: Given a (b)(4) motion docketed 2026-10-28, then the November amount is held at $2,699.22 and the change applies only per the court's order.", async () => {
  const n = { id: "pcn-BK-13-A-2026-11-01", effective_due_date: D("2026-11-01"), old_total_cents: 269_922n, new_total_cents: 280_672n, status: "filed_served" as const };
  const h0 = b4MotionHold(n, { docketed_on: D("2026-10-28") });
  assert.equal(h0.status, "objected"); assert.equal(h0.held, true); assert.equal(h0.hold_amount_cents, 269_922n); assert.equal(h0.bills_on_due_date_cents, 269_922n); assert.equal(h0.applies_on, null);
  assert.equal(h0.awaiting, "court_order"); assert.equal(h0.escalation.kind, "attorney"); assert.match(h0.escalation.reason, /2026-10-28/);
  const gate = evaluateGate("14.2.noB4MotionBeforeDueDate", h0.gate_facts); assert.equal(gate.open, false); assert.match(gate.reason!, /2026-10-28/);
  assert.equal(evaluateGate("14.2.noB4MotionBeforeDueDate", { b4_motion_docketed: false }).open, true);
  assert.equal(evaluateGate("14.2.noB4MotionBeforeDueDate", { ...h0.gate_facts, court_order_entered: true }).open, true, "the court's order ends the hold");
  const o = applyCourtOrder(n, { entered_on: D("2026-11-20"), determined_total_cents: 280_672n, effective_from: D("2026-12-01") });
  assert.equal(o.status, "determined"); assert.equal(o.amount_cents, 280_672n); assert.equal(o.applies_from, "2026-12-01"); assert.equal(o.entered_on, "2026-11-20");
  // a motion on or after the due date does not hold the change (it went into effect on that date)
  assert.equal(b4MotionHold(n, { docketed_on: D("2026-11-01") }).held, false); assert.equal(b4MotionHold(n, { docketed_on: D("2026-11-01") }).bills_on_due_date_cents, 280_672n);
  assert.equal(effectiveOnDueDate({ ...n, objection: { docketed_on: D("2026-10-28") } }, D("2026-11-01")).bills_cents, 269_922n); assert.equal(effectiveOnDueDate({ ...n, objection: { docketed_on: D("2026-11-01") } }, D("2026-11-01")).status, "effective");
  // through the bus: the notice is filed and served 2026-09-30; the 14.1 monitor dockets the (b)(4) motion on 2026-10-28 → objected, the old amount held, counsel escalated; on the due date the gate stays closed and $2,699.22 bills; the court's order (2026-11-20) sets $2,806.72 from 2026-12-01 → determined, and the monitor closes on the order, never on the agent's figures
  const h = harness("2026-09-25T14:00:00Z"); const r = await h.fileS1("2026-09-30"); const nid = r.detect.notice_id as string;
  const monitor = h.last("FRBP_3002_1B4_OBJECTION_WINDOW"); assert.equal(monitor.status, "armed"); assert.equal(monitor.anchorDate, "2026-11-01");
  h.clock.set("2026-10-28T18:00:00Z"); h.events.append(docket("objection_to_payment_change", { docketed_on: "2026-10-28", docket_no: "47" }));
  const hold = await h.run("bk.change.detect", { loan_id: LOAN, op: "docket_event", kind: "objection_to_payment_change", notice_id: nid, docketed_on: "2026-10-28", docket_event_id: "dk-47" });
  assert.equal(hold.held, true); assert.equal(hold.hold_amount_cents, 269_922n); assert.equal(h.rt.store.get("bk_payment_change_notices", nid)!.data.status, "objected"); assert.deepEqual(h.rt.escalations.opened.map((e) => [e.kind, e.payload.reason_code]), [["attorney", "b4_motion"]]);
  assert.deepEqual(h.emitted("bankruptcy.payment_change_notice.status_changed").map((e) => [e.payload.status, e.payload.hold_amount_cents]), [["objected", 269_922n]]);
  const nov = await h.run("bk.change.detect", { loan_id: LOAN, op: "effective", notice_id: nid }, BK, "2026-11-01T12:00:00Z");
  assert.equal(nov.effective, false); assert.equal(nov.status, "objected"); assert.equal(nov.bills_cents, 269_922n); assert.equal(nov.gate.open, false); assert.equal(monitor.status, "armed", "the monitor waits for the court's order");
  const order = await h.run("bk.change.detect", { loan_id: LOAN, op: "docket_event", kind: "order_on_payment_change", notice_id: nid, entered_on: "2026-11-20", determined_total_cents: 280_672n, effective_from: "2026-12-01", order_document_id: "doc-order-2026-11-20" }, BK, "2026-11-20T18:00:00Z");
  assert.equal(order.status, "determined"); assert.equal(order.applies_from, "2026-12-01"); const stored = h.rt.store.get("bk_payment_change_notices", nid)!.data; assert.equal(stored.status, "determined"); assert.equal(stored.effective_date_applied, "2026-12-01"); assert.equal((stored.order as { determined_total_cents: bigint }).determined_total_cents, 280_672n);
  assert.equal(monitor.status, "satisfied"); assert.equal(eventMatches(loadOverriddenRegistry().get("FRBP_3002_1B4_OBJECTION_WINDOW")!.satisfiedPattern!, h.emitted("bankruptcy.payment_change_notice.status_changed").at(-1)!), true);
  assert.equal((await h.run("bk.change.detect", { loan_id: LOAN, op: "effective", notice_id: nid }, BK, "2026-12-01T12:00:00Z")).status, "determined");
});
test("14.2-T11: Given the 410S-1 checklist detects payment-change date < notice date + 21, then the package is blocked.", async () => {
  // notice dated 2026-10-15 for the 2026-11-01 change: 2026-10-15 + 21 = 2026-11-05 > 2026-11-01 → FRBP_3002_1B_DATE_GE_21 fails, the package is blocked
  const late = form410s1({ notice_date: D("2026-10-15"), effective_due_date: D("2026-11-01"), pi_new_cents: PI, escrow_new_cents: ESCROW_NEW, new_total_cents: NEW_TOTAL, parts: [1], escrow_old_cents: 64_500n, escrow_statement_document_id: "doc-escrow-2026-09-25", account_last4: "4821", signer_role: "authorized_agent" });
  assert.equal(daysBetween(D("2026-10-15"), D("2026-11-01")), 17); assert.equal(late.checklist.FRBP_3002_1B_DATE_GE_21, false); assert.equal(late.blocked, true); assert.deepEqual(late.failed, ["FRBP_3002_1B_DATE_GE_21"]);
  // exactly 21 days (notice dated 2026-10-11) passes; the other checks are unaffected
  const ok = form410s1({ notice_date: D("2026-10-11"), effective_due_date: D("2026-11-01"), pi_new_cents: PI, escrow_new_cents: ESCROW_NEW, new_total_cents: NEW_TOTAL, parts: [1], escrow_old_cents: 64_500n, escrow_statement_document_id: "doc-escrow-2026-09-25", account_last4: "4821", signer_role: "authorized_agent" });
  assert.equal(ok.checklist.FRBP_3002_1B_DATE_GE_21, true); assert.equal(ok.blocked, false); assert.deepEqual(ok.part1, { current_escrow_cents: 64_500n, new_escrow_cents: 75_250n, escrow_statement_attached: true });
  // the rendered Official Form 410S-1 carries the same block on its header line "Date of payment change — Must be at least 21 days after date of this notice"
  const payload = { creditor_name: "Fannie Mae (Supermortgage, servicer)", claim_no: "7", account_last4: "4821", notice_date: "2026-10-15", date_of_payment_change: "2026-11-01", new_total_cents: NEW_TOTAL, pi_new_cents: PI, part1: { current_escrow_cents: 64_500n, new_escrow_cents: 75_250n, escrow_statement_attached: true }, signer_role: "authorized_agent", signer_name: "S. Officer", signed_on: "2026-10-15" };
  const doc = renderCourtForm("CRT_B410S1", payload);
  assert.equal(doc.blocked, true); assert.deepEqual(doc.failed, ["FRBP_3002_1B_DATE_GE_21"]); assert.match(doc.text, /Date of payment change — Must be at least 21 days after date of this notice: 2026-11-01/); assert.match(doc.text, /under penalty of perjury that the information provided in this claim is true and correct/);
  assert.equal(renderCourtForm("CRT_B410S1", { ...payload, notice_date: "2026-09-30" }).blocked, false);
  // a notice without its date cannot prove the 21 days; without a signer, with a total that is not P&I + escrow, or with the escrow statement missing it is blocked too
  assert.deepEqual(renderCourtForm("CRT_B410S1", { ...payload, notice_date: undefined }).failed, ["FRBP_3002_1B_DATE_GE_21"]);
  assert.deepEqual(renderCourtForm("CRT_B410S1", { ...payload, notice_date: "2026-09-30", signer_role: undefined, signer_name: undefined }).failed, ["SIGNER_ROLE_PRESENT"]);
  assert.deepEqual(renderCourtForm("CRT_B410S1", { ...payload, notice_date: "2026-09-30", new_total_cents: NEW_TOTAL + 1n }).failed, ["FORM410S1_TOTAL_EQ_PI_PLUS_ESCROW"]);
  assert.deepEqual(renderCourtForm("CRT_B410S1", { ...payload, notice_date: "2026-09-30", part1: { ...payload.part1, escrow_statement_attached: false } }).failed, ["FORM410S1_PART1_ESCROW_ATTACHED"]);
  // through the bus: bk.notice.render refuses the late-dated package, documents.render refuses the blocked form
  const h = harness("2026-10-15T14:00:00Z"); const d = await h.run("bk.change.detect", { ...DETECT, detected_on: "2026-10-15" });
  await assert.rejects(h.run("bk.notice.render", { ...RENDER_S1, notice_id: d.notice_id, notice_date: "2026-10-15" }), /410S-1 checklist block: FRBP_3002_1B_DATE_GE_21/);
  await assert.rejects(h.run("documents.render", { loan_id: LOAN, template_code: "CRT_B410S1", payload }), /content block: FRBP_3002_1B_DATE_GE_21/);
  await h.refused("bk.notice.render", { ...RENDER_S1, notice_id: d.notice_id, notice_date: "2026-10-08", new_total_cents: NEW_TOTAL + 100n }, "FIGURES_MUST_TIE");
  assert.equal((await h.run("bk.notice.render", { ...RENDER_S1, notice_id: d.notice_id, notice_date: "2026-10-08" })).status, "package_ready");
});
test("14.2-T12: Given a relief order entered while the case remains open, then filings continue (policy) and the decision record cites 14.2-Q2.", async () => {
  const r = reliefOrderDecision({ relief_order_entered_on: D("2026-12-10"), case_open: true, counsel_advises_improper: false, case_id: "case-BK-13-A" });
  assert.equal(r.continue_filing, true); assert.equal(r.in_scope, true); assert.equal(r.gate, "SM_BK_3002_1_RELIEF_CEASE_CHECK");
  assert.equal(r.decision.rule_code, "14.2-Q2"); assert.match(r.decision.rationale, /14\.2-Q2/); assert.match(r.decision.rationale, /unless the court orders otherwise/); assert.equal(r.decision.scope_test_result, "in_scope_policy_continue"); assert.equal(r.decision.outcome, "continue_filing"); assert.equal(r.decision.case_id, "case-BK-13-A"); assert.match(r.decision.computation_hash, /^[0-9a-f]{64}$/);
  const d = detectChange({ source: "escrow_analysis", old_total_cents: 269_922n, new_total_cents: 280_672n, effective_due_date: D("2027-02-01"), detected_on: D("2026-12-15") }, { chapter: "13", principal_residence: true, treatment: "cure_and_maintain", relief_order_effective: true, case_open: true });
  assert.equal(d.in_scope, true); assert.equal(d.status, "computed"); assert.equal(d.decision.rule_code, "14.2-Q2"); assert.match(d.decision.rationale, /14\.2-Q2/); assert.equal(d.deadline_file_serve, "2027-01-11");
  assert.equal(reliefOrderDecision({ relief_order_entered_on: D("2026-12-10"), case_open: true, counsel_advises_improper: true }).continue_filing, false);
  assert.equal(reliefOrderDecision({ relief_order_entered_on: D("2026-12-10"), case_open: false, counsel_advises_improper: false }).continue_filing, false);
  assert.equal(detectChange({ source: "escrow_analysis", old_total_cents: 269_922n, new_total_cents: 280_672n, effective_due_date: D("2027-02-01"), detected_on: D("2026-12-15") }, { chapter: "13", principal_residence: true, treatment: "cure_and_maintain", relief_order_effective: true, case_open: false }).status, "out_of_scope");
  // the 14.2-Q2 exception reaches the scope test: counsel's advice ceases the filings with a decision record (unless the court ordered continued compliance)
  const ceased = detectChange({ source: "escrow_analysis", old_total_cents: 269_922n, new_total_cents: 280_672n, effective_due_date: D("2027-02-01"), detected_on: D("2026-12-15") }, { chapter: "13", principal_residence: true, treatment: "cure_and_maintain", relief_order_effective: true, case_open: true, counsel_advises_improper: true });
  assert.equal(ceased.status, "out_of_scope"); assert.equal(ceased.decision.scope_test_result, "ceased_on_relief"); assert.equal(ceased.decision.rule_code, "14.2-Q2"); assert.match(ceased.decision.rationale, /counsel advises.*14\.2-Q2 exception/);
  assert.equal(detectChange({ source: "escrow_analysis", old_total_cents: 269_922n, new_total_cents: 280_672n, effective_due_date: D("2027-02-01"), detected_on: D("2026-12-15") }, { chapter: "13", principal_residence: true, treatment: "cure_and_maintain", relief_order_effective: true, case_open: true, counsel_advises_improper: true, court_orders_continued_compliance: true }).status, "computed");
  // `SM_BK_3002_1_RELIEF_CEASE_CHECK` gate: open (keep filing) by default after a relief order while the case is open; closed when the case is closed or counsel advises the notices are improper; the court ordering continued compliance keeps it open
  const gate = "14.2.rule3002_1NoticesCeaseAfterRelief";
  assert.equal(evaluateGate(gate, r.gate_facts).open, true);
  assert.equal(evaluateGate(gate, reliefOrderDecision({ relief_order_entered_on: D("2026-12-10"), case_open: true, counsel_advises_improper: true }).gate_facts).open, false);
  const closed = evaluateGate(gate, reliefOrderDecision({ relief_order_entered_on: D("2026-12-10"), case_open: false, counsel_advises_improper: false }).gate_facts); assert.equal(closed.open, false); assert.match(closed.reason!, /ceased/);
  assert.equal(evaluateGate(gate, reliefOrderDecision({ relief_order_entered_on: D("2026-12-10"), case_open: true, counsel_advises_improper: true, court_orders_continued_compliance: true }).gate_facts).open, true);
  assert.equal(evaluateGate(gate, { relief_order_entered: false }).open, true);
  const row = loadOverriddenRegistry().get("SM_BK_3002_1_RELIEF_CEASE_CHECK")!; assert.deepEqual(row.offsetParsed, { kind: "evaluator", ref: gate }); assert.match(row.overrideWhy!, /14\.2-Q2/); assert.match(row.overrideWhy!, /orders otherwise/);
  // through the bus: the docketed relief order is recorded as a scope decision; the next detected change is filed under 14.2-Q2 without the caller restating the facts; counsel's later advice ceases the filings with a persisted decision and an event, not a silent skip
  const h = harness("2026-12-10T18:00:00Z"); h.events.append(docket("relief_order_entered", { entered_at: "2026-12-10", docket_no: "60" })); assert.equal(h.last("SM_BK_3002_1_RELIEF_CEASE_CHECK").note, "evaluator:14.2.rule3002_1NoticesCeaseAfterRelief");
  const rel = await h.run("bk.change.detect", { loan_id: LOAN, case_id: CASE, op: "docket_event", kind: "relief_order_entered", entered_on: "2026-12-10", docket_event_id: "dk-60" });
  assert.equal(rel.continue_filing, true); assert.equal(h.rt.store.get("bk_rule3002_1_scope", LOAN)!.data.continue_filing, true); assert.deepEqual(h.emitted("bankruptcy.rule3002_1.scope_decided").map((e) => [e.payload.continue_filing, e.payload.rule_code]), [[true, "14.2-Q2"]]);
  const d2 = await h.run("bk.change.detect", { ...DETECT, effective_due_date: "2027-02-01", detected_on: "2026-12-15" }, BK, "2026-12-15T14:00:00Z");
  assert.equal(d2.status, "computed"); assert.equal(d2.decision.rule_code, "14.2-Q2"); assert.equal(d2.decision.scope_test_result, "in_scope_policy_continue"); assert.equal(d2.deadline_file_serve, "2027-01-11"); assert.equal(h.last("BK_3002_1_PAYMENT_CHANGE_21").dueDate, "2027-01-11");
  const advice = await h.run("bk.change.detect", { loan_id: LOAN, case_id: CASE, op: "docket_event", kind: "relief_order_entered", entered_on: "2026-12-10", counsel_advises_improper: true, counsel_advice_document_id: "doc-counsel-2027-01" }, BK, "2027-01-05T14:00:00Z");
  assert.equal(advice.continue_filing, false); assert.equal(evaluateGate(gate, h.rt.store.get("bk_rule3002_1_scope", LOAN)!.data).open, false);
  const d3 = await h.run("bk.change.detect", { ...DETECT, effective_due_date: "2027-03-01", detected_on: "2027-01-06" }, BK, "2027-01-06T14:00:00Z");
  assert.equal(d3.status, "out_of_scope"); assert.equal(d3.notice_id, null); assert.equal(d3.decision.scope_test_result, "ceased_on_relief"); assert.equal(d3.decision.rule_code, "14.2-Q2");
  assert.equal(h.rt.store.get("bk_payment_change_decisions", d3.decision_id as string)!.data.outcome, "skipped_with_decision_record"); assert.equal(h.emitted("bankruptcy.payment_change_notice.created").at(-1)!.payload.in_scope, false); assert.equal(h.inst("BK_3002_1_PAYMENT_CHANGE_21").length, 1, "no gate armed for a ceased filing");
});
test("14.2-T13: Given an ARM change effective 2027-02-01 with the Reg Z notice generated 2026-11-20, then the 410S-1 (Part 2, notice attached) is filed by 2026-11-27 and the deadline 2027-01-11 is satisfied.", async () => {
  // rule 3: the Reg Z notice on 2026-11-20 falls in the 60–120-day §1026.20(c) window for 2027-02-01
  assert.equal(daysBetween(D("2026-11-20"), D("2027-02-01")), 73);
  const a = armChangeNotice({ reg_z_notice_on: D("2026-11-20"), effective_due_date: D("2027-02-01"), rate_old: "6.500", rate_new: "7.000", pi_old_cents: 205_422n, pi_new_cents: 215_000n, escrow_cents: 75_250n, rate_change_notice_document_id: "doc-regz-2027-02", filed_served_on: D("2026-11-27") });
  assert.equal(a.part, 2); assert.equal(a.attachment_ok, true); assert.deepEqual(a.part2, { current_rate: "6.500", new_rate: "7.000", current_pi_cents: 205_422n, new_pi_cents: 215_000n });
  // spec: "filed by 2026-11-27" — 5 BD from Friday 2026-11-20 counted through Thanksgiving (2026-11-26); the servicer calendar lands on Monday 2026-11-30
  assert.equal(a.file_by, "2026-11-30");
  assert.equal(a.deadline_file_serve, "2027-01-11"); assert.equal(paymentChangeDeadline(D("2027-02-01")).deadline, "2027-01-11");
  assert.equal(a.filed_on, "2026-11-27"); assert.equal(a.deadline_satisfied, true); assert.equal(a.timely, true); assert.equal(a.days_notice, 66);
  const f = form410s1({ notice_date: D("2026-11-27"), effective_due_date: D("2027-02-01"), pi_new_cents: 215_000n, escrow_new_cents: 75_250n, new_total_cents: a.new_total_cents, parts: [2], pi_old_cents: 205_422n, rate_old: "6.500", rate_new: "7.000", rate_change_notice_document_id: "doc-regz-2027-02", account_last4: "4821", signer_role: "authorized_agent" });
  assert.equal(f.blocked, false); assert.equal(f.part1, null); assert.equal(f.part2!.rate_change_notice_attached, true); assert.equal(f.checklist.FORM410S1_PART2_RATE_NOTICE_ATTACHED, true);
  const missing = form410s1({ notice_date: D("2026-11-27"), effective_due_date: D("2027-02-01"), pi_new_cents: 215_000n, escrow_new_cents: 75_250n, new_total_cents: a.new_total_cents, parts: [2], rate_change_notice_document_id: null, account_last4: "4821", signer_role: "authorized_agent" });
  assert.equal(missing.blocked, true); assert.deepEqual(missing.failed, ["FORM410S1_PART2_RATE_NOTICE_ATTACHED"]);
  // through the bus: the 7.2 change carries the Reg Z notice date → the notice row records file_by (5 BD) and the 9006 deadline; the Part 2 package with the rate notice attached is filed 2026-11-27 and the gate on 2027-01-11 is satisfied
  const h = harness("2026-11-20T14:00:00Z");
  const arm = { loan_id: LOAN, case_id: CASE, source: "arm_adjustment", old_total_cents: 280_672n, new_total_cents: 290_250n, effective_due_date: "2027-02-01", chapter: "13", treatment: "cure_and_maintain", principal_residence: true, detected_on: "2026-11-20", reg_z_notice_on: "2026-11-20", rate_old: "6.500", rate_new: "7.000", pi_old_cents: 205_422n, pi_new_cents: 215_000n, escrow_old_cents: 75_250n, escrow_new_cents: 75_250n, rate_change_notice_document_id: "doc-regz-2027-02" };
  const d = await h.run("bk.change.detect", arm); assert.equal(d.part, 2); assert.equal(d.file_by, "2026-11-30"); assert.equal(d.deadline_file_serve, "2027-01-11"); assert.equal(h.emitted("bankruptcy.payment_change_notice.created")[0]!.payload.file_by, "2026-11-30"); assert.equal(h.last("BK_3002_1_PAYMENT_CHANGE_21").dueDate, "2027-01-11");
  await assert.rejects(h.run("bk.notice.render", { loan_id: LOAN, form: "410S-1", notice_id: d.notice_id, effective_due_date: "2027-02-01", pi_new_cents: 215_000n, escrow_new_cents: 75_250n, new_total_cents: 290_250n, parts: [2], pi_old_cents: 205_422n, rate_old: "6.500", rate_new: "7.000", account_last4: "4821", signer_role: "authorized_agent", notice_date: "2026-11-27", analysis: { id: "arm-2027-02", pi_new_cents: 215_000n, escrow_new_cents: 75_250n } }), /FORM410S1_PART2_RATE_NOTICE_ATTACHED/);
  const pkg = await h.run("bk.notice.render", { loan_id: LOAN, form: "410S-1", notice_id: d.notice_id, effective_due_date: "2027-02-01", pi_new_cents: 215_000n, escrow_new_cents: 75_250n, new_total_cents: 290_250n, parts: [2], pi_old_cents: 205_422n, rate_old: "6.500", rate_new: "7.000", rate_change_notice_document_id: "doc-regz-2027-02", account_last4: "4821", signer_role: "authorized_agent", notice_date: "2026-11-27", analysis: { id: "arm-2027-02", pi_new_cents: 215_000n, escrow_new_cents: 75_250n } });
  assert.equal(pkg.part2.rate_change_notice_attached, true);
  const fl = await h.run("attorney.send_package", { loan_id: LOAN, op: "hand_off", filing_type: "s1_payment_change", package_id: pkg.package_id, notice_id: d.notice_id, deadline_file_serve: "2027-01-11", effective_due_date: "2027-02-01" }); await h.run("attorney.send_package", { loan_id: LOAN, op: "signed", filing_id: fl.id, signer_id: "u-signer" }, SIGNER);
  const c = await h.run("attorney.send_package", { loan_id: LOAN, op: "confirm_filed_served", filing_id: fl.id, filed_at: "2026-11-27T16:00:00Z", served_at: "2026-11-27T16:00:00Z", nef_at: "2026-11-27T16:00:00Z", nef_docket_no: "55", certificate_of_service_document_id: "doc-cos", service: CM_ECF_SERVICE, mail_manifest_id: "mm", mail_manifest_date: "2026-11-27" }, BK, "2026-11-27T17:00:00Z");
  assert.equal(c.timeliness.timely, true); assert.equal(c.timeliness.days_notice, 66); assert.equal(h.last("BK_3002_1_PAYMENT_CHANGE_21").status, "satisfied");
});
test("14.2-T14: Given two changes for 2027-03-01 (ARM and escrow) detected on different days, then a single superseding 410S-1 with Parts 1 and 2 is filed and the first is marked `superseded`.", async () => {
  const first: NoticeRow = { id: "pcn-arm-2027-03", effective_due_date: D("2027-03-01"), parts: [2], status: "filed_served", detected_on: D("2026-12-03"), source: "arm_adjustment" };
  const r = supersedingNotice(first, { id: "pcn-escrow-2027-03", source: "escrow_analysis", detected_on: D("2027-01-05"), effective_due_date: D("2027-03-01") });
  assert.equal(r.same_due_date, true); assert.equal(r.single_filing, true); assert.deepEqual(r.filing.parts, [1, 2]); assert.equal(r.filing.supersedes, "pcn-arm-2027-03"); assert.equal(r.filing.status, "computed");
  assert.equal(r.prior.id, "pcn-arm-2027-03"); assert.equal(r.prior.status, "superseded");
  assert.equal(paymentChangeDeadline(D("2027-03-01")).deadline, "2027-02-08");
  const f = form410s1({ notice_date: D("2027-01-06"), effective_due_date: D("2027-03-01"), pi_new_cents: 215_000n, escrow_new_cents: 78_000n, new_total_cents: 293_000n, parts: r.filing.parts, escrow_old_cents: 75_250n, pi_old_cents: 205_422n, rate_old: "6.500", rate_new: "7.000", escrow_statement_document_id: "doc-escrow-2027", rate_change_notice_document_id: "doc-regz-2027-03", account_last4: "4821", signer_role: "authorized_agent" });
  assert.ok(f.part1 && f.part2); assert.equal(f.part4, null); assert.equal(f.blocked, false); assert.equal(f.checklist.FRBP_3002_1B_DATE_GE_21, true); assert.equal(f.checklist.FORM410S1_TOTAL_EQ_PI_PLUS_ESCROW, true);
  // a change for a different due date is its own notice and supersedes nothing
  const other = supersedingNotice(first, { id: "pcn-escrow-2027-04", source: "escrow_analysis", detected_on: D("2027-01-05"), effective_due_date: D("2027-04-01") });
  assert.equal(other.single_filing, false); assert.equal(other.filing.supersedes, null); assert.deepEqual(other.filing.parts, [1]); assert.equal(other.prior.status, "filed_served");
  // through the bus: the ARM change (2026-12-03) and the escrow change (2027-01-05) for 2027-03-01 → the second notice carries Parts 1 and 2 and supersedes the first, whose row and event say so; the single package renders with both attachments
  const h = harness("2026-12-03T14:00:00Z");
  const armIn = { loan_id: LOAN, case_id: CASE, id: "pcn-arm-2027-03", source: "arm_adjustment", old_total_cents: 280_672n, new_total_cents: 290_250n, effective_due_date: "2027-03-01", chapter: "13", treatment: "cure_and_maintain", principal_residence: true, detected_on: "2026-12-03", reg_z_notice_on: "2026-12-03", rate_old: "6.500", rate_new: "7.000", pi_old_cents: 205_422n, pi_new_cents: 215_000n, escrow_old_cents: 75_250n, escrow_new_cents: 75_250n, rate_change_notice_document_id: "doc-regz-2027-03" };
  const a = await h.run("bk.change.detect", armIn); assert.deepEqual(a.parts, [2]); assert.equal(a.supersedes, null);
  const e = await h.run("bk.change.detect", { loan_id: LOAN, case_id: CASE, id: "pcn-escrow-2027-03", source: "escrow_analysis", old_total_cents: 290_250n, new_total_cents: 293_000n, effective_due_date: "2027-03-01", chapter: "13", treatment: "cure_and_maintain", principal_residence: true, detected_on: "2027-01-05", pi_old_cents: 215_000n, pi_new_cents: 215_000n, escrow_old_cents: 75_250n, escrow_new_cents: 78_000n, escrow_statement_document_id: "doc-escrow-2027" }, BK, "2027-01-05T14:00:00Z");
  assert.deepEqual(e.parts, [1, 2]); assert.equal(e.supersedes, "pcn-arm-2027-03"); assert.equal(h.rt.store.get("bk_payment_change_notices", "pcn-arm-2027-03")!.data.status, "superseded"); assert.equal(h.rt.store.get("bk_payment_change_notices", "pcn-arm-2027-03")!.data.superseded_by, "pcn-escrow-2027-03");
  assert.deepEqual(h.emitted("bankruptcy.payment_change_notice.status_changed").map((x) => [x.payload.notice_id, x.payload.status, x.payload.superseded_by]), [["pcn-arm-2027-03", "superseded", "pcn-escrow-2027-03"]]);
  assert.equal(h.emitted("bankruptcy.payment_change_notice.created").at(-1)!.payload.supersedes, "pcn-arm-2027-03"); assert.deepEqual(h.emitted("bankruptcy.payment_change_notice.created").at(-1)!.payload.parts, [1, 2]);
  const pkg = await h.run("bk.notice.render", { loan_id: LOAN, form: "410S-1", notice_id: "pcn-escrow-2027-03", effective_due_date: "2027-03-01", pi_new_cents: 215_000n, escrow_new_cents: 78_000n, new_total_cents: 293_000n, parts: e.parts, escrow_old_cents: 75_250n, pi_old_cents: 205_422n, rate_old: "6.500", rate_new: "7.000", escrow_statement_document_id: "doc-escrow-2027", rate_change_notice_document_id: "doc-regz-2027-03", account_last4: "4821", signer_role: "authorized_agent", notice_date: "2027-01-06", analysis: { id: "ea-2027-01-05", pi_new_cents: 215_000n, escrow_new_cents: 78_000n } }, BK, "2027-01-06T14:00:00Z");
  assert.ok(pkg.part1 && pkg.part2); assert.equal(pkg.status, "package_ready");
  const superseded = h.rt.store.get("bk_payment_change_notices", "pcn-arm-2027-03")!.data; assert.equal(effectiveOnDueDate({ id: "pcn-arm-2027-03", effective_due_date: D("2027-03-01"), old_total_cents: 280_672n, new_total_cents: 290_250n, status: superseded.status as "superseded" }, D("2027-03-01")).effective, false);
});

test("14.2 timers: FNMA_E2_1_04_DOCS_TO_FIRM_3BD arms on counsel's figures request for a 3002.1 paper (attorney.send_package op=request_figures) and is satisfied when the figures are delivered from a computation log (op=deliver_figures) — 3 servicer business days", async () => {
  const req = figuresRequest({ request_id: "rq-1", firm_id: "firm-ndca", filing_type: "nr_final_cure_response", requested_at: "2026-10-16T15:00:00-04:00" });
  assert.equal(req.requested_on, "2026-10-16"); assert.equal(req.due, "2026-10-21"); assert.equal(req.timer, "FNMA_E2_1_04_DOCS_TO_FIRM_3BD"); assert.equal(req.breached, false); assert.equal(req.late, false);
  assert.throws(() => figuresRequest({ request_id: "rq-x", firm_id: "firm", filing_type: "poc", requested_at: "2026-10-16T15:00:00Z" }), RangeError);
  const h = harness("2026-10-16T19:00:00Z");
  const r = await h.run("attorney.send_package", { loan_id: LOAN, case_id: CASE, op: "request_figures", request_id: "rq-1", firm_id: "firm-ndca", filing_type: "s1_payment_change", subject: "figures for the 410S-1 (escrow analysis 2026-09-25)", requested_at: "2026-10-16T15:00:00-04:00" });
  assert.equal(r.due, "2026-10-21"); const ev = h.emitted("attorney.document_request.received")[0]!; assert.equal(ev.payload.request_at, "2026-10-16T15:00:00-04:00"); assert.equal(ev.payload.filing_type, "s1_payment_change");
  const row = loadOverriddenRegistry().get("FNMA_E2_1_04_DOCS_TO_FIRM_3BD")!; assert.equal(eventMatches(row.triggerPattern!, ev), true);
  const t = h.last("FNMA_E2_1_04_DOCS_TO_FIRM_3BD"); assert.equal(t.anchorDate, "2026-10-16"); assert.equal(t.dueDate, "2026-10-21"); assert.equal(t.status, "armed");
  await assert.rejects(h.run("attorney.send_package", { loan_id: LOAN, op: "deliver_figures", request_id: "rq-1" }, BK, "2026-10-20T14:00:00Z"), /computation_hash or package_id is required/);
  const d = await h.run("attorney.send_package", { loan_id: LOAN, op: "deliver_figures", request_id: "rq-1", computation_hash: "c".repeat(64) }, BK, "2026-10-20T14:00:00Z");
  assert.equal(d.late, false); assert.equal(d.escalation_id, null); assert.equal(eventMatches(row.satisfiedPattern!, h.emitted("attorney.document_request.fulfilled")[0]!), true); assert.equal(t.status, "satisfied"); assert.equal(h.rt.store.get("bk_counsel_figure_requests", "rq-1")!.data.status, "fulfilled");
  // late delivery: the timer breaches on 2026-10-22 (sev-2) and the delivery records the breach with an officer escalation
  await h.run("attorney.send_package", { loan_id: LOAN, op: "request_figures", request_id: "rq-2", firm_id: "firm-ndca", filing_type: "s2_fee_notice", requested_at: "2026-10-16T15:00:00-04:00" }, BK, "2026-10-16T19:00:00Z");
  assert.deepEqual(h.timers.evaluate("2026-10-22T12:00:00Z").map((b) => [b.instance.code, b.severity]), [["FNMA_E2_1_04_DOCS_TO_FIRM_3BD", 2]]);
  const lateD = await h.run("attorney.send_package", { loan_id: LOAN, op: "deliver_figures", request_id: "rq-2", computation_hash: "d".repeat(64) }, BK, "2026-10-22T14:00:00Z"); assert.equal(lateD.late, true); assert.ok(lateD.escalation_id); assert.equal(h.last("FNMA_E2_1_04_DOCS_TO_FIRM_3BD").status, "satisfied_late");
});
test("14.2 inputs: `fee.incurred_postpetition` ingestion validates the 2.7/9.x/13.6 record (line 1–14, a past incurrence date, a positive amount, evidence) and waives — never notices — what the servicer will not recover or Fannie Mae reimbursed", async () => {
  const today = D("2026-12-05");
  const ok = ingestFeeItem({ id: "f1", line: "7", incurred_on: "2026-11-05", amount_cents: 2_000n, recoverable_basis: "security instrument ¶9", evidence_document_id: "doc-1" }, [], today);
  assert.equal(ok.item.status, "incurred"); assert.equal(ok.first_unnoticed, true); assert.equal(ok.event.type, "fee.incurred_postpetition"); assert.equal(ok.event.payload.first_unnoticed, true); assert.equal(ok.item.notice_deadline, "2027-05-04"); assert.equal(ok.item.description, "Property inspection fees");
  assert.equal(ingestFeeItem({ id: "f2", line: "7", incurred_on: "2026-11-06", amount_cents: 2_000n, recoverable_basis: "¶9", evidence_document_id: "doc-2" }, [{ id: "f1", status: "incurred", recoverable: true }], today).first_unnoticed, false);
  assert.equal(ingestFeeItem({ id: "f2", line: "7", incurred_on: "2026-11-06", amount_cents: 2_000n, recoverable_basis: "¶9", evidence_document_id: "doc-2" }, [{ id: "f1", status: "noticed", recoverable: true }], today).first_unnoticed, true, "a noticed item is not an open one");
  for (const bad of [{ line: "15" }, { line: "escrow" }, { incurred_on: "2026-13-01" }, { incurred_on: "2026-12-06" }, { amount_cents: 0n }, { evidence_document_id: null }]) assert.throws(() => ingestFeeItem({ id: "x", line: "7", incurred_on: "2026-11-05", amount_cents: 2_000n, recoverable_basis: "¶9", evidence_document_id: "doc", ...bad }, [], today), RangeError, JSON.stringify(bad, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
  const lc = ingestFeeItem({ id: "lc", line: "1", incurred_on: "2026-11-16", amount_cents: 8_217n, recoverable_basis: null, evidence_document_id: "doc-lc" }, [], today); assert.equal(lc.item.status, "waived"); assert.equal(lc.event.type, "bankruptcy.fee_item.waived"); assert.match(lc.waived_reason!, /no recoverable_basis/);
  const reimbursed = ingestFeeItem({ id: "rb", line: "3", incurred_on: "2026-11-16", amount_cents: 40_000n, recoverable_basis: "exhibit: MFR", evidence_document_id: "doc-rb", fnma_reimbursed: true }, [], today); assert.equal(reimbursed.item.status, "waived"); assert.match(reimbursed.waived_reason!, /netting rule/);
  assert.equal(ingestFeeItem({ id: "rb", line: "3", incurred_on: "2026-11-16", amount_cents: 40_000n, recoverable_basis: "exhibit: MFR", evidence_document_id: "doc-rb", fnma_reimbursed: true, netting_rule_confirmed: true }, [], today).item.status, "incurred");
  // through the bus: a waived item is persisted with its reason and arms no timer; the reimbursed item's recovery is refused without the netting rule
  const h = harness("2026-12-05T14:00:00Z");
  const w = await h.run("bk.fee_items.read/batch", { loan_id: LOAN, case_id: CASE, op: "incur", id: "lc-2026-11", line: "1", incurred_on: "2026-11-16", amount_cents: 8_217n, evidence_document_id: "doc-lc" }); assert.equal(w.event, "bankruptcy.fee_item.waived"); assert.deepEqual(w.timers, []); assert.equal(h.inst("BK_3002_1C_FEE_NOTICE_180").length, 0);
  await h.refused("bk.fee_items.read/batch", { loan_id: LOAN, op: "incur", id: "rb", line: "3", incurred_on: "2026-11-16", amount_cents: 40_000n, recoverable_basis: "exhibit", evidence_document_id: "doc-rb", fnma_reimbursed: true, assert_recoverable: true }, "FNMA_REIMBURSED_NOT_NOTICED");
  assert.equal((await h.run("bk.fee_items.read/batch", { loan_id: LOAN, op: "incur", id: "rb", line: "3", incurred_on: "2026-11-16", amount_cents: 40_000n, recoverable_basis: "exhibit", evidence_document_id: "doc-rb", fnma_reimbursed: true })).waived_reason?.includes("netting"), true);
  await assert.rejects(h.run("bk.fee_items.read/batch", { loan_id: LOAN, op: "incur", id: "future", line: "7", incurred_on: "2026-12-06", amount_cents: 2_000n, recoverable_basis: "¶9", evidence_document_id: "doc" }), RangeError);
});
test("14.2 rule 7: `bankruptcy.plan.completed` freezes the ledger views (validated trustee signal, hashed snapshot) and the 45-day watch breaches when no Form 410C13-N is docketed", async () => {
  const views: FrozenLedgerViews = { prepetition_arrearage_cents: 0n, postpetition: [{ due: D("2031-05-01"), amount_cents: NEW_TOTAL, paid_cents: NEW_TOTAL }], unpaid_noticed_fees_cents: 0n, escrow_balance_cents: 150_000n, unapplied_cents: 0n, deferred_interest_cents: 0n, last_payment_received_on: D("2031-05-03"), history: [], amortization: BK13A_NOTE, escrow_monthly_cents: ESCROW_NEW, cure_received_cents: 1_424_194n, postpetition_received_cents: null, source_view_id: "lv-1" };
  const f = planCompletionFreeze({ completed_on: "2031-05-20", source: "final_voucher", final_voucher_id: "TFS-1" }, views, "2031-05-21T12:00:00Z");
  assert.equal(f.watch.lapses_on, "2031-07-04"); assert.equal(f.event.payload.completed_on, "2031-05-20"); assert.match(f.ledger_snapshot_hash, /^[0-9a-f]{64}$/); assert.equal(f.ledger_snapshot_hash, planCompletionFreeze({ completed_on: "2031-05-20", source: "tfs", final_voucher_id: "TFS-2" }, views, "2031-05-22T12:00:00Z").ledger_snapshot_hash, "the hash is over the views and the completion date, not the signal");
  assert.throws(() => planCompletionFreeze({ completed_on: "2031-05-20", source: "email" }, views, "2031-05-21T12:00:00Z"), RangeError); assert.throws(() => planCompletionFreeze({ completed_on: "2031-05-20", source: "final_voucher" }, views, "2031-05-21T12:00:00Z"), /final_voucher_id/); assert.throws(() => planCompletionFreeze({ completed_on: "2031-05-22", source: "trustee_final_report" }, views, "2031-05-21T12:00:00Z"), /future/);
  const row = loadOverriddenRegistry().get("SM_BK_3002_1G1_TRUSTEE_NOTICE_WATCH_45")!; assert.equal(row.triggerPattern!.type, "bankruptcy.plan.completed"); assert.equal(row.anchorField, "completed_on"); assert.equal(computeDue(row.offsetParsed, D("2031-05-20"), noon("2031-05-20")).dueDate, "2031-07-04");
  const h = harness("2031-05-21T12:00:00Z");
  await assert.rejects(h.run("bk.status_response.compute", { loan_id: LOAN, op: "plan_completed", completed_on: "2031-05-20", source: "trustee_final_report" }), /no bankruptcy_ledger_views/);
  const fz = await h.run("bk.status_response.compute", { loan_id: LOAN, case_id: CASE, op: "plan_completed", completed_on: "2031-05-20", source: "trustee_final_report", views: ledgerView(["2031-05-01"]) });
  const ev = h.emitted("bankruptcy.plan.completed")[0]!; assert.equal(eventMatches(row.triggerPattern!, ev), true); assert.equal(ev.payload.completed_on, "2031-05-20"); assert.equal(ev.payload.ledger_snapshot_hash, fz.ledger_snapshot_hash);
  const watch = h.last("SM_BK_3002_1G1_TRUSTEE_NOTICE_WATCH_45"); assert.equal(watch.dueDate, "2031-07-04");
  assert.equal(h.timers.evaluate("2031-07-04T20:00:00Z").length, 0); assert.deepEqual(h.timers.evaluate("2031-07-05T12:00:00Z").map((b) => [b.instance.code, b.breachText]), [["SM_BK_3002_1G1_TRUSTEE_NOTICE_WATCH_45", row.breach]]); assert.match(row.breach, /counsel/);
  h.clock.set("2031-07-10T12:00:00Z"); h.events.append(docket("trustee_notice_410c13_n", { served_at: "2031-07-10", service_method: "mail" })); assert.equal(watch.status, "satisfied_late");
  assert.equal((await h.run("bk.status_response.compute", { loan_id: LOAN, op: "trigger", kind: "trustee_notice_410c13_n", served_on: "2031-07-10", by_mail: true })).response_deadline, "2031-08-11");   // 28 + 3 = Sunday 2031-08-10 → Monday
  assert.equal(responseTrigger("motion_410c13_m2", D("2031-08-10"), false, null).timer, "FRBP_3002_1G4_MOTION_RESPONSE_28"); assert.throws(() => responseTrigger("objection_to_payment_change", D("2031-08-10"), false, null), RangeError);
});
test("14.2 outputs: the court-form checklists fail on real defects — untied totals, off-form or previously noticed 410S-2 items, an unsigned declaration, an unredacted account, an incomplete service list — and pass an all-mail certificate", () => {
  const s2 = { creditor_name: "Fannie Mae (Supermortgage, servicer)", claim_no: "7", account_last4: "4821", lines: [{ line_no: "5", description: "Bankruptcy/Proof of claim fees", amount_cents: 155_000n, dates_incurred: ["2026-10-20"] }, { line_no: "7", description: "Property inspection fees", amount_cents: 4_000n, dates_incurred: ["2026-11-05", "2026-12-05"] }], total_cents: 159_000n, fee_item_ids: ["a", "b", "c", "d"], previously_noticed_ids: ["z"], signer_role: "authorized_agent", signer_name: "S. Officer", signed_on: "2027-01-14" };
  assert.equal(renderCourtForm("CRT_B410S2", s2).blocked, false);
  assert.deepEqual(renderCourtForm("CRT_B410S2", { ...s2, total_cents: 159_001n }).failed, ["FORM410S2_TOTAL_EQ_SUM"]);
  assert.deepEqual(renderCourtForm("CRT_B410S2", { ...s2, previously_noticed_ids: ["b"] }).failed, ["FORM410S2_NO_PREVIOUSLY_NOTICED_ITEMS"]);
  assert.deepEqual(renderCourtForm("CRT_B410S2", { ...s2, lines: [...s2.lines, { line_no: "8", description: "Escrow disbursement (county tax)", amount_cents: 0n, dates_incurred: ["2026-12-10"] }] }).failed, ["FORM410S2_NO_ESCROW_DISBURSEMENTS"]);
  assert.deepEqual(renderCourtForm("CRT_B410S2", { ...s2, lines: [{ ...s2.lines[0]!, dates_incurred: [] }, s2.lines[1]!] }).failed, ["FORM410S2_DATES_PRESENT"]);
  assert.deepEqual(renderCourtForm("CRT_B410S2", { ...s2, lines: [], total_cents: 0n }).failed, ["FORM410S2_LINES_PRESENT"]);
  assert.deepEqual(renderCourtForm("CRT_B410S2", { ...s2, signer_role: "paralegal" }).failed, ["SIGNER_ROLE_PRESENT"]);
  assert.deepEqual(renderCourtForm("CRT_B410S2", { ...s2, claim_no: "1234567890" }).failed, ["FRBP_9037_REDACTION"]); assert.deepEqual(renderCourtForm("CRT_B410S2", { ...s2, account_last4: "004821" }).failed, ["FRBP_9037_REDACTION"]);
  assert.deepEqual(renderCourtForm("CRT_B410S2", { ...s2, creditor_name: " " }).failed, ["CREDITOR_NAMED"]);
  // the 410S-2 checklist from the batch itself: an item a prior notice itemized, an escrow disbursement, a date after the notice, a total that does not tie to the open memo
  const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, incurred_on: D("2026-11-05"), cents: 2_000n, line: "7", recoverable: true, status: "incurred" as const, ...extra });
  assert.deepEqual(form410s2Lines([item("a"), item("b")], D("2026-12-01"), { previously_noticed_ids: ["b"] }).failed, ["FORM410S2_NO_PREVIOUSLY_NOTICED_ITEMS"]);
  assert.deepEqual(form410s2Lines([item("a"), item("b", { noticed_on: D("2026-11-30") })], D("2026-12-01")).failed, ["FORM410S2_NO_PREVIOUSLY_NOTICED_ITEMS"]);
  assert.deepEqual(form410s2Lines([item("a"), item("b", { escrow_disbursement: true })], D("2026-12-01")).failed, ["FORM410S2_NO_ESCROW_DISBURSEMENTS"]); assert.deepEqual(form410s2Lines([item("a", { line: "16" })], D("2026-12-01")).failed, ["FORM410S2_NO_ESCROW_DISBURSEMENTS"]);
  assert.deepEqual(form410s2Lines([item("a"), item("b", { incurred_on: D("2026-12-05") })], D("2026-12-01")).failed, ["FORM410S2_DATES_PRESENT"]);
  assert.deepEqual(form410s2Lines([item("a"), item("b")], D("2026-12-01"), { memo_balance_cents: 6_000n }).failed, ["FORM410S2_TOTAL_EQ_SUM"]); assert.equal(form410s2Lines([item("a"), item("b")], D("2026-12-01"), { memo_balance_cents: 4_000n }).passed, true);
  // certificate of service (rule 8): debtor by mail (or consented e-mail), counsel and trustee by CM/ECF or mail; a pro se debtor has no attorney to serve
  const cos = { creditor_name: "Fannie Mae", account_last4: "4821", served_on: "2026-09-30", paper: "Notice of Mortgage Payment Change", service_list: [{ party: "debtor", method: "mail", address: "1 Main St" }, { party: "debtor_attorney", method: "cm_ecf" }, { party: "trustee", method: "cm_ecf" }], signer_role: "authorized_agent", signer_name: "S. Officer", signed_on: "2026-09-30" };
  assert.equal(renderCourtForm("CRT_CERTIFICATE_OF_SERVICE", cos).blocked, false);
  assert.equal(renderCourtForm("CRT_CERTIFICATE_OF_SERVICE", { ...cos, service_list: cos.service_list.map((p) => ({ ...p, method: "mail" })) }).blocked, false, "every party by mail (counsel withdrawn, trustee not registered) is a valid certificate");
  assert.deepEqual(renderCourtForm("CRT_CERTIFICATE_OF_SERVICE", { ...cos, service_list: cos.service_list.slice(0, 2) }).failed, ["SERVICE_LIST_COMPLETE"]);
  assert.equal(renderCourtForm("CRT_CERTIFICATE_OF_SERVICE", { ...cos, pro_se: true, service_list: [cos.service_list[0]!, cos.service_list[2]!] }).blocked, false);
  assert.deepEqual(renderCourtForm("CRT_CERTIFICATE_OF_SERVICE", { ...cos, service_list: [{ party: "debtor", method: "email" }, ...cos.service_list.slice(1)] }).failed, ["DEBTOR_SERVED_BY_MAIL_OR_CONSENTED_EMAIL"]);
  assert.equal(renderCourtForm("CRT_CERTIFICATE_OF_SERVICE", { ...cos, service_list: [{ party: "debtor", method: "email", consent: true }, ...cos.service_list.slice(1)] }).blocked, false);
  assert.deepEqual(renderCourtForm("CRT_CERTIFICATE_OF_SERVICE", { ...cos, served_on: "" }).failed, ["SERVED_ON_PRESENT"]);
  // a 410C13 response must be the computed response for that form
  const nr = form410c13nr({ served_on: D("2031-06-20"), by_mail: false, arrearage_cents: 0n, postpetition: [], unpaid_noticed_fees_cents: 0n, next_due: D("2031-07-01"), next_due_cents: NEW_TOTAL, upb_cents: 28_862_518n, deferred_interest_cents: 0n, escrow_balance_cents: 0n, unapplied_cents: 0n, history: [] });
  const sig = { creditor_name: "Fannie Mae", claim_no: "7", account_last4: "4821", signer_role: "creditor", signer_name: "S. Officer", signed_on: "2031-07-10" };
  assert.deepEqual(renderCourtForm("CRT_B410C13_M1R", { ...sig, response: nr }).failed, ["RESPONSE_FORM_MATCHES_TEMPLATE"]); assert.deepEqual(renderCourtForm("CRT_B410C13_NR", sig).failed, ["RESPONSE_PRESENT", "RESPONSE_FORM_MATCHES_TEMPLATE", "FORM410C13NR_SUPPLEMENT_TO_CLAIM"]);
  assert.match(renderCourtForm("CRT_B410C13_NR", { ...sig, response: nr }).text, /I am the creditor\./);
  // Rule 9006(a)(6)(C): a district holiday on the rolled day pushes a forward period one more day; the backward 21-day count never uses it
  assert.equal(rollForward9006Court(D("2027-04-18"), [D("2027-04-19")]), "2027-04-20"); assert.equal(noticeDeadline180(D("2026-10-20"), [D("2027-04-19")]), "2027-04-20"); assert.equal(paymentChangeDeadline(D("2026-11-01")).deadline, "2026-10-09");
});

test("14.2 worked figures: escrow $645.00 + $1,290.00 shortage ÷ 12 → $752.50; totals $2,699.22 → $2,806.72 (late: Nov bills $2,699.22, Dec $2,806.72, $107.50 timing loss; decrease to $2,650.00 applies on the actual due date); 410S-2 line 5 $1,550.00 + line 7 $40.00 = $1,590.00, challenge 2028-01-18; 410C13-NR UPB $288,625.18 after payment #95, next due 2031-07-01 $2,054.22 + escrow", () => {
  const e = postpetitionEscrowChange({ pi_cents: 205_422n, escrow_old_cents: 64_500n, shortage_cents: 129_000n, effective_due_date: D("2026-11-01") });
  assert.equal(e.shortage_monthly_cents, 10_750n); assert.equal(e.escrow_new_cents, 75_250n); assert.equal(e.old_total_cents, 269_922n); assert.equal(e.new_total_cents, 280_672n); assert.equal(e.change_kind, "increase");
  assert.equal(e.deadline_file_serve, "2026-10-09"); assert.equal(e.target_file_date, "2026-09-25");
  assert.deepEqual(deadlineCalc(D("2026-11-01")).holidays_applied.map((h) => h.date), ["2026-10-11", "2026-10-10"]);
  const timely = untimelyNoticeBilling({ effective_due_date: D("2026-11-01"), served_on: D("2026-09-30"), old_total_cents: e.old_total_cents, new_total_cents: e.new_total_cents, timing_loss_monthly_cents: e.shortage_monthly_cents });
  assert.equal(timely.timely, true); assert.equal(timely.days_notice, 32); assert.equal(timely.installments[0]!.bills_cents, 280_672n); assert.equal(timely.pushed_event, null); assert.equal(timely.timing_loss_cents, 0n);
  const late = untimelyNoticeBilling({ effective_due_date: D("2026-11-01"), served_on: D("2026-10-15"), old_total_cents: e.old_total_cents, new_total_cents: e.new_total_cents, timing_loss_monthly_cents: e.shortage_monthly_cents });
  assert.equal(late.timely, false); assert.equal(late.effective_date_applied, "2026-12-01");
  assert.deepEqual(late.installments, [{ due: "2026-11-01", bills_cents: 269_922n }, { due: "2026-12-01", bills_cents: 280_672n }]);
  assert.deepEqual(late.pushed_event, { type: "payment.change.effective_date.pushed", from: "2026-11-01", to: "2026-12-01" }); assert.equal(late.timing_loss_cents, 10_750n); assert.equal(late.re_notice, false);
  const dec = untimelyNoticeBilling({ effective_due_date: D("2026-11-01"), served_on: D("2026-10-15"), old_total_cents: 269_922n, new_total_cents: 265_000n });
  assert.equal(dec.timely, false); assert.equal(dec.effective_date_applied, "2026-11-01"); assert.deepEqual(dec.installments, [{ due: "2026-11-01", bills_cents: 265_000n }, { due: "2026-12-01", bills_cents: 265_000n }]); assert.equal(dec.pushed_event, null);
  // rule 5: counsel's POC & plan review $1,225 + 410A history $325 (line 5) and two $20 inspections (line 7)
  const items: FeeItem[] = [{ incurred_on: D("2026-10-20"), cents: 122_500n, line: "5", recoverable: true, status: "incurred" }, { incurred_on: D("2026-10-20"), cents: 32_500n, line: "5", recoverable: true, status: "incurred" }, { incurred_on: D("2026-11-05"), cents: 2_000n, line: "7", recoverable: true, status: "incurred" }, { incurred_on: D("2026-12-05"), cents: 2_000n, line: "7", recoverable: true, status: "incurred" }];
  const b = feeBatchSchedule(items, D("2027-01-15"));
  assert.equal(b.file_now, true); assert.equal(b.reason, "aggregate ≥ $200"); assert.equal(b.aggregate_cents, 159_000n); assert.equal(b.fnma_fee_claimable, true); assert.equal(b.files_on, "2027-01-15"); assert.equal(daysBetween(D("2026-10-20"), b.files_on!), 87); assert.equal(b.preclusion_first, "2027-04-19"); assert.equal(b.before_day_180, true);
  const s2 = form410s2Lines(items, D("2027-01-15"));
  assert.deepEqual(s2.lines, [{ line_no: "5", description: "Bankruptcy/Proof of claim fees", amount_cents: 155_000n, dates_incurred: ["2026-10-20"] }, { line_no: "7", description: "Property inspection fees", amount_cents: 4_000n, dates_incurred: ["2026-11-05", "2026-12-05"] }]);
  assert.equal(s2.total_cents, 159_000n); assert.equal(s2.checklist.FORM410S2_TOTAL_EQ_SUM, true); assert.equal(s2.checklist.FORM410S2_DATES_PRESENT, true); assert.equal(s2.passed, true); assert.equal(s2.challenge_deadline, "2028-01-18");
  // the (e) one-year window in the engine: served 2027-01-15 + 12 months = Saturday 2028-01-15 → Sunday, MLK Day 2028-01-17 → Tuesday 2028-01-18
  const r365 = loadOverriddenRegistry().get("FRBP_3002_1E_FEE_CHALLENGE_365")!; assert.equal(r365.anchorField, "served_at"); assert.equal(computeDue(r365.offsetParsed, D("2027-01-15"), noon("2027-01-15")).dueDate, "2028-01-18"); assert.equal(isFederalHoliday(D("2028-01-17")), true);
  const doc = renderCourtForm("CRT_B410S2", { creditor_name: "Fannie Mae (Supermortgage, servicer)", claim_no: "7", account_last4: "4821", lines: s2.lines, total_cents: s2.total_cents, fee_item_ids: ["a", "b", "c", "d"], signer_role: "authorized_agent", signer_name: "S. Officer", signed_on: "2027-01-14" });
  assert.equal(doc.blocked, false); assert.match(doc.text, /5\. Bankruptcy\/Proof of claim fees \| Dates incurred: 2026-10-20 \| Amount: \$1,550\.00/); assert.match(doc.text, /7\. Property inspection fees \| Dates incurred: 2026-11-05, 2026-12-05 \| Amount: \$40\.00/); assert.match(doc.text, /Total: \$1,590\.00/); assert.match(doc.text, /Do not include any escrow account disbursements or any amounts previously itemized in a notice filed in this case/);
  // rule 7: fixture BK-13-A — $325,000 at 6.500%/360: P&I $2,054.22; UPB after the 2031-06-01 installment (payment #95) $288,625.18
  assert.equal(levelPayment(32_500_000n, ratePercent("6.500"), 360), 205_422n);
  const upb95 = balanceAfter(32_500_000n, "6.500", 360, 95); assert.equal(upb95, 28_862_518n); assert.ok(balanceAfter(32_500_000n, "6.500", 360, 94) > upb95);
  const paid = (due: string) => ({ due: D(due), amount_cents: 205_422n + 75_250n, paid_cents: 205_422n + 75_250n });
  const nr = form410c13nr({ served_on: D("2031-06-20"), by_mail: false, arrearage_cents: 0n, postpetition: [paid("2031-04-01"), paid("2031-05-01"), paid("2031-06-01")], unpaid_noticed_fees_cents: 0n, last_payment_received_on: D("2031-06-03"), next_due: D("2031-07-01"), next_due_cents: 205_422n + 75_250n, upb_cents: upb95, deferred_interest_cents: 0n, escrow_balance_cents: 150_000n, unapplied_cents: 0n, history: [] });
  assert.equal(nr.part2.statement, "paid in full"); assert.equal(nr.part3.statement, "current"); assert.equal(nr.part3.upb_cents, 28_862_518n); assert.equal(nr.part3.next_due_date, "2031-07-01"); assert.equal(nr.part3.next_due_cents, 280_672n); assert.equal(nr.part3.deferred_interest_cents, 0n); assert.equal(nr.part3.source, "explicit");
  assert.equal(nr.response_due, "2031-07-18"); assert.equal(nr.agree, true); assert.equal(nr.fnma_fee_cents, 12_500n); assert.equal(nr.precludes_later_default_claim, true); assert.equal(nr.part4_history, null);
  assert.equal(form410c13nr({ served_on: D("2031-06-20"), by_mail: true, arrearage_cents: 0n, postpetition: [], unpaid_noticed_fees_cents: 0n, last_payment_received_on: null, next_due: D("2031-07-01"), next_due_cents: 280_672n, upb_cents: upb95, deferred_interest_cents: 0n, escrow_balance_cents: 0n, unapplied_cents: 0n, history: [] }).response_due, "2031-07-21");
});
