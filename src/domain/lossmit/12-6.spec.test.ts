// 12.6 Payment Deferral
// spec/sections/12-loss-mitigation/12-6-payment-deferral.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, daysBetween } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, type TimerInstance } from "../../kernel/timers/index.ts";
import { eventMatches, parseEventPattern } from "../../kernel/events/match.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput, type ToolDef } from "../../app/tools.ts";
import { SECTION_12_TOOLS } from "../../app/tools/section12.ts";
import { TOOLS_12_6 } from "../../app/tools/section12-6.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakeFnmaSmdu } from "../../infra/integrations/fnma.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { FakeErecording } from "../../infra/integrations/legal.ts";
import { NoticeService } from "../../notices/service.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { delinquencyMilestone } from "../early-intervention/ops.ts";
import { capStructure, deferralSolicitationClocks, deferralOfferOnCompleteApp, deferralLedger, smduDeferralOutage, recordableAgreement, arrears } from "./ops.ts";
import { nib, newPayment, timeline, screen, type DeferralFacts } from "./deferral.ts";
import { balanceAfter } from "./flexmod.ts";
import { watchDeferralEvents, confirmCustodianDelivery, recordedOriginalReceived, notifyFnmaLegal, recordContractualPayment, postDeferralRedelinquency, offerDeferral, completeDeferral, type DeferralEnv } from "./ops-12-6.ts";

/** The worked loan: $250,000 / 6.5% / 360, first payment 2021-11-01; LPI 2026-05-01 = 55 payments made; the four deferred installments would have taken it to 59. */
const PRE_DEFERRAL_UPB = balanceAfter(25_000_000n, "6.500", 360, 55);
const SCHEDULED_UPB = balanceAfter(25_000_000n, "6.500", 360, 59);
/** The worked facts: 4 months delinquent on the 2026-09-20 evaluation; originated 2021-10; no prior deferral; 348 months to maturity. */
const T1_FACTS: DeferralFacts = { months_delinquent: 4, origination_date: D("2021-10-01"), evaluation_date: D("2026-09-20"), cumulative_deferred_months: 0, months_to_maturity: 348 };

// ---- the §12.6 tools on the command bus with a TimerEngine over the overridden registry: every 12.6 timer is armed by the event a tool (or ops-12-6 function) appends and satisfied by the event the responding tool / inbound ingestion appends.
const AGENT: Actor = { kind: "agent", id: "lossmit-underwriter" };
const SIGNING_OFFICER: Actor = { kind: "human", id: "u-so", role: "signing_officer" };
const INVESTOR_REPORTING: Actor = { kind: "system", id: "investor-reporting" };
const LOAN = "L-126";
const RECIPIENTS = [{ partyId: "b1", name: "Borrower", mailingAddress: "1 Test St, Testville TX 75001" }];
const toolKey = (process: string, name: string): string => `${process} ${name}`;
function harness(nowIso = "2026-09-20T14:00:00.000Z") {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  // REGX_1024_41E1_ACCEPT_14 is a shared 12.2/12.6 row; the rest are 12.6's own.
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["12.2", "12.6"] });
  const uow: UowContext = { loanId: LOAN, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const noticeReg = buildRegistry(); publishAuthored(noticeReg);
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, notices: new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }), ports: { smdu: new FakeFnmaSmdu(), printMail: new FakePrintMail(), edelivery: new FakeEdelivery(), erecording: new FakeErecording() } };
  watchDeferralEvents({ events, store: rt.store });   // the 12.6 derivations over the 12.2 offer response and the 11.1 day-60 milestone
  const agents = new AgentRegistry(); const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of [...SECTION_12_TOOLS, ...TOOLS_12_6] as readonly ToolDef[]) if (d.process === "12.6" || d.process === "12.2") { const c = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, c.name); cmds.set(toolKey(d.process, d.name), c); }
  const bus = new CommandBus(agents);
  const run = async <O = Record<string, unknown>>(name: string, input: ToolInput, opts: { actor?: Actor; now?: string; process?: string } = {}): Promise<O> => { if (opts.now) clock.set(opts.now); return (await bus.execute(cmds.get(toolKey(opts.process ?? "12.6", name))!, opts.actor ?? AGENT, { loan_id: LOAN, ...input }, uow)).output as O; };
  const refused = (name: string, input: ToolInput, code: string, actor: Actor = AGENT) => assert.rejects(bus.execute(cmds.get(toolKey("12.6", name))!, actor, { loan_id: LOAN, ...input }, uow), (e: unknown) => e instanceof CommandRefused && e.code === code);
  const rejects = (name: string, input: ToolInput, re: RegExp, opts: { actor?: Actor; now?: string } = {}) => { if (opts.now) clock.set(opts.now); return assert.rejects(bus.execute(cmds.get(toolKey("12.6", name))!, opts.actor ?? AGENT, { loan_id: LOAN, ...input }, uow), (e: unknown) => e instanceof RangeError && re.test(e.message)); };
  const emitted = (type: string): readonly DomainEvent[] => events.all().filter((e) => e.type === type);
  const armed = (code: string, due?: string): TimerInstance => { const t = timers.byCode(code).at(-1); assert.ok(t, `${code} armed`); assert.equal(t.status, "armed", `${code} status`); if (due !== undefined) assert.equal(t.dueDate, due, `${code} due`); return t; };
  const satisfied = (code: string, byType: string): TimerInstance => { const t = timers.byCode(code).find((x) => x.status === "satisfied"); assert.ok(t, `${code} satisfied`); assert.equal(events.all().find((e) => e.id === t.satisfiedByEventId)!.type, byType, `${code} satisfied by`); return t; };
  const notice = (code: string, extra: ToolInput = {}) => run("notice.render_send", { template_code: code, recipients: RECIPIENTS, payload: noticeReg.activeVersion(code, D(clock.now().slice(0, 10)))!.samplePayload, ...extra });
  const env = (): DeferralEnv => ({ events, store: rt.store, actor: AGENT, now: clock.now() });
  const deferral = () => rt.store.list("payment_deferrals", (d) => d.loan_id === LOAN).at(-1)!.data;
  return { clock, events, timers, rt, run, refused, rejects, emitted, armed, satisfied, notice, env, deferral, decisions, noticeReg };
}
type H = ReturnType<typeof harness>;
/** Offer (or solicit) on the screen, accept through the 12.2 offer response, report the contractual payments (LAR) and complete in SMDU. */
async function offerAcceptComplete(h: H, o: { facts?: DeferralFacts; basis?: string; offer_on?: string; accept_on: string; complete_on: string; recording_required?: boolean; processing_month_elected?: boolean; skip_completion?: boolean } ) {
  const facts = o.facts ?? T1_FACTS;
  await h.run("deferral.screen", { facts, basis: o.basis ?? "streamlined", ...(o.recording_required ? { recording_required: true } : {}), ...(o.processing_month_elected ? { processing_month_elected: true } : {}) }, { now: o.offer_on ?? `${facts.evaluation_date}T14:00:00.000Z` });
  await h.run("lossmit.evaluation.*", { op: "offer_response", response: "accepted", option: "payment_deferral", accepted_via: "written", responded_on: o.accept_on }, { process: "12.2", now: `${o.accept_on}T15:00:00.000Z` });
  const led = await h.run("ledger.arrears_breakdown", { pi_cents: 158_017n, months_deferred: 4, escrow_advances_cents: 105_000n, servicing_advances_cents: 0n, late_charges_cents: 25_200n, pre_deferral_ib_upb_cents: PRE_DEFERRAL_UPB, scheduled_ib_upb_cents: SCHEDULED_UPB });
  await h.run("investor.report_contractual_payments", { deferral_ledger_id: led.deferral_ledger_id });
  if (o.skip_completion) return;
  await h.run("smdu.case.submit", { workout: "payment_deferral", partner_servicer_number: "123456789", campaign_id: "PD-2026" }, { now: `${o.complete_on}T16:00:00.000Z` });
}

test("12.6-T1: Given the 4-payment example, when accepted 2026-09-22, then NIB = $7,370.68, late charges $252.00 waived, new payment $2,131.17, SMDU entry by 2026-09-30, LAR/events by 2026-09-29, effective 2026-10-01, agreement sent by completion + 5 days, custodian by 2026-10-26.", async () => {
  const s = screen(T1_FACTS);
  assert.deepEqual(s, { eligible: true, contractual_payment_required: false, months_deferred: 4 });
  assert.equal(nib(158_017n, 4, 105_000n, 0n), 737_068n);
  const led = deferralLedger({ pi_cents: 158_017n, months_deferred: 4, escrow_advances_cents: 105_000n, servicing_advances_cents: 0n, late_charges_cents: arrears({ piti_cents: 210_000n, unpaid_installments: 4, late_charge_cents: 6_300n, late_charges: 4 }).late_charges_cents, pre_deferral_ib_upb_cents: PRE_DEFERRAL_UPB, scheduled_ib_upb_cents: SCHEDULED_UPB });
  assert.equal(led.postings.find((p) => p.account === "late_charges_due")!.credit, 25_200n);
  assert.deepEqual(newPayment(158_017n, 52_000n, 186_000n), { shortage_monthly_cents: 3_100n, payment_cents: 213_117n });
  // Accepted and completed 2026-09-22: the evaluation month governs — no processing month is needed or elected.
  const tl = timeline(D("2026-09-20"), { completion_on: D("2026-09-22") });
  assert.equal(tl.processing_month, false); assert.equal(tl.entry_deadline, "2026-09-30"); assert.equal(tl.lar_deadline, "2026-09-29"); assert.equal(tl.effective, "2026-10-01"); assert.equal(tl.agreement_by, "2026-09-27"); assert.equal(tl.custodian_by, "2026-10-26");

  // The same example on the bus: screen → offer (BRP basis) → Evaluation Notice → acceptance 2026-09-22 → LAR → SMDU completion → agreement → custodian, each clock armed and satisfied by the events the tools emit.
  const h = harness();
  const offered = await h.run("deferral.screen", { facts: T1_FACTS, basis: "brp", application_complete: true });
  assert.equal(offered.eligible, true); assert.equal((offered.deferral as Record<string, unknown>).status, "offered"); assert.equal((offered.deferral as Record<string, unknown>).evaluation_notice_required, true);
  assert.equal(h.emitted("payment_deferral.offered")[0]!.payload.decided_on, "2026-09-20");
  h.armed("FNMA_D2205_EVAL_NOTICE_DEFERRAL_5", "2026-09-25");   // decision + 5 calendar days (D2-2-05)
  await h.notice("NTC_FNMA_D23204_DEFERRAL_OFFER", { tier: "ge_90", state: "TX", option: "payment_deferral" });
  h.satisfied("FNMA_D2205_EVAL_NOTICE_DEFERRAL_5", "notice.sent");
  await h.run("lossmit.evaluation.*", { op: "offer_response", response: "accepted", option: "payment_deferral", accepted_via: "written", responded_on: "2026-09-22" }, { process: "12.2", now: "2026-09-22T15:00:00.000Z" });
  const accepted = h.emitted("payment_deferral.accepted"); assert.equal(accepted.length, 1);
  assert.equal(accepted[0]!.payload.accepted_on, "2026-09-22"); assert.equal(accepted[0]!.payload.completion_month_end, "2026-09-30"); assert.equal(accepted[0]!.payload.lar_by, "2026-09-29"); assert.equal(accepted[0]!.payload.processing_month, false);
  h.armed("FNMA_D23204_DEFERRAL_SMDU_ENTRY_EOM", "2026-09-30"); h.armed("FNMA_F122_DEFERRAL_LAR_BEFORE_EOM_1BD");
  // Completion before the LAR is refused (F-1-22); the case is not submitted.
  await h.rejects("smdu.case.submit", { workout: "payment_deferral", partner_servicer_number: "123456789", campaign_id: "PD-2026" }, /assertLarBeforeCompletion/);
  assert.equal(h.emitted("smdu.case.submitted").length, 0);
  const led2 = await h.run("ledger.arrears_breakdown", { pi_cents: 158_017n, months_deferred: 4, escrow_advances_cents: 105_000n, servicing_advances_cents: 0n, late_charges_cents: 25_200n, pre_deferral_ib_upb_cents: PRE_DEFERRAL_UPB, scheduled_ib_upb_cents: SCHEDULED_UPB });
  assert.equal(led2.deferred_principal_cents, 737_068n);
  await h.run("investor.report_contractual_payments", { deferral_ledger_id: led2.deferral_ledger_id });
  h.events.append({ type: "investor.event.accepted", loanId: LOAN, actor: INVESTOR_REPORTING, payload: { kind: "contractual_payments", months: 4, accepted_on: "2026-09-22" } });   // the 5.x ack
  h.satisfied("FNMA_F122_DEFERRAL_LAR_BEFORE_EOM_1BD", "investor.event.accepted");
  const done = await h.run("smdu.case.submit", { workout: "payment_deferral", partner_servicer_number: "123456789", campaign_id: "PD-2026" });
  assert.equal(done.effective_date, "2026-10-01"); assert.equal(done.entry_deadline, "2026-09-30"); assert.equal(done.processing_month, false);
  const completed = h.emitted("payment_deferral.completed"); assert.equal(completed.length, 1); assert.equal(completed[0]!.payload.completed_on, "2026-09-22"); assert.equal(completed[0]!.payload.agreement_by, "2026-09-27"); assert.equal(completed[0]!.payload.custodian_by, "2026-10-26"); assert.equal(completed[0]!.payload.campaign_id, "PD-2026");
  const effective = h.emitted("payment_deferral.effective"); assert.equal(effective.length, 1); assert.equal(effective[0]!.payload.effective_date, "2026-10-01"); assert.equal(effective[0]!.payload.next_due_date, "2026-10-01"); assert.equal(effective[0]!.payload.regx_days_delinquent, 0);
  h.satisfied("FNMA_D23204_DEFERRAL_SMDU_ENTRY_EOM", "smdu.case.submitted");
  h.armed("FNMA_D23204_AGREEMENT_SEND_5", "2026-09-27"); h.armed("FNMA_D23204_CUSTODIAN_25", "2026-10-26"); h.armed("FNMA_F202_DEFERRAL_INCENTIVE_CLAIM", "2026-10-31");
  assert.equal(h.deferral().status, "completed"); assert.equal(h.deferral().next_due_date, "2026-10-01");
  await h.run("esign.send", { document_id: "doc-agr-1", document: "DOC_FNMA_PAYMENT_DEFERRAL_AGREEMENT" }, { now: "2026-09-24T10:00:00.000Z" });
  h.satisfied("FNMA_D23204_AGREEMENT_SEND_5", "lossmit.agreement.sent");
  await h.run("custodian.deliver", { document: "executed_copy" }, { now: "2026-10-09T10:00:00.000Z" });
  const c = confirmCustodianDelivery(h.env(), { loan_id: LOAN, document: "executed_copy", confirmed_on: D("2026-10-09"), receipt_id: "cust-1" });
  assert.equal(c.complete, true); assert.equal(h.deferral().status, "documented");
  h.satisfied("FNMA_D23204_CUSTODIAN_25", "custodian.delivery.confirmed");
  h.events.append({ type: "investor.event.accepted", loanId: LOAN, actor: INVESTOR_REPORTING, payload: { kind: "incentive", workout: "payment_deferral", amount_cents: 50_000n } });   // F-2-02 $500
  h.satisfied("FNMA_F202_DEFERRAL_INCENTIVE_CLAIM", "investor.event.accepted");
  // The offer/solicit command armed the evaluator-backed gates: the B-1-01 escrow gate closes on the 3.x analysis; the criteria gate has no satisfier (it is re-tested at completion).
  await h.run("escrow.analysis.run", {}); h.events.append({ type: "escrow.analysis.completed", loanId: LOAN, actor: { kind: "system", id: "escrow" }, payload: { purpose: "workout", shortage_cents: 186_000n, shortage_monthly_cents: 3_100n } });
  h.satisfied("FNMA_B101_ESCROW_ANALYSIS_BEFORE_OFFER", "escrow.analysis.completed");
  assert.deepEqual(h.timers.open().filter((t) => t.dueDate !== undefined).map((t) => t.code), [], "every dated 12.6 clock of the worked example closes on the events the tools emit");
  assert.deepEqual(h.timers.open().map((t) => t.code), ["FNMA_D23204_DEFERRAL_ELIGIBILITY_GATES"]);
});
test("12.6-T2: (window) 1 month delinquent → ineligible (reason `INV_FNMA_D23204_DELQ_WINDOW`); 7 months → ineligible; 6 months → eligible with the contractual-payment gate.", async () => {
  const base = { origination_date: D("2021-10-01"), evaluation_date: D("2026-09-20"), cumulative_deferred_months: 0, months_to_maturity: 348 };
  const one = screen({ months_delinquent: 1, ...base }); assert.equal(one.eligible, false); if (!one.eligible) { assert.equal(one.reason, "INV_FNMA_D23204_DELQ_WINDOW"); assert.equal(one.next, "flex_mod"); }
  const seven = screen({ months_delinquent: 7, ...base }); assert.equal(seven.eligible, false); if (!seven.eligible) assert.equal(seven.reason, "INV_FNMA_D23204_DELQ_WINDOW");
  const six = screen({ months_delinquent: 6, ...base }); assert.deepEqual(six, { eligible: true, contractual_payment_required: true, months_deferred: 6 });
  // On the bus: the ineligible screen is never offered — it is routed to the lossmit_reviewer (adverse determination) with the reason code; the 6-month screen is offered with the gate, and completion is refused until the full contractual payment lands in the solicitation month.
  const h = harness();
  const r1 = await h.run("deferral.screen", { facts: { months_delinquent: 1, ...base }, basis: "streamlined" });
  assert.equal(r1.eligible, false); assert.equal(r1.reason, "INV_FNMA_D23204_DELQ_WINDOW"); assert.equal(r1.deferral, undefined);
  assert.equal(h.emitted("payment_deferral.offered").length, 0); assert.equal(h.emitted("payment_deferral.screened_ineligible")[0]!.payload.reason, "INV_FNMA_D23204_DELQ_WINDOW"); assert.equal(h.emitted("payment_deferral.screened_ineligible")[0]!.payload.next, "flex_mod");
  assert.equal(h.emitted("escalation.created").filter((e) => e.payload.kind === "lossmit_reviewer").length, 1);
  await h.run("deferral.screen", { facts: { months_delinquent: 7, ...base }, basis: "streamlined" });
  assert.equal(h.emitted("payment_deferral.screened_ineligible").length, 2); assert.equal(h.emitted("payment_deferral.offered").length, 0);
  await offerAcceptComplete(h, { facts: { months_delinquent: 6, ...base }, accept_on: "2026-09-22", complete_on: "2026-09-25", skip_completion: true });
  assert.equal(h.deferral().contractual_payment_required, true); assert.equal(h.deferral().status, "awaiting_contractual_payment"); assert.equal(h.emitted("payment_deferral.offered")[0]!.payload.months_deferred, 6);
  await h.rejects("smdu.case.submit", { workout: "payment_deferral", partner_servicer_number: "123456789", campaign_id: "PD-2026" }, /FNMA_D23204_CONTRACTUAL_PAYMENT_GATE/, { now: "2026-09-25T16:00:00.000Z" });
  assert.equal(h.emitted("smdu.case.submitted").length, 0);
  const partial = recordContractualPayment(h.env(), { loan_id: LOAN, received_on: D("2026-09-24"), amount_cents: 100_000n, contractual_payment_cents: 210_000n });
  assert.equal(partial.full, false); assert.equal(h.deferral().status, "awaiting_contractual_payment");
  const full = recordContractualPayment(h.env(), { loan_id: LOAN, received_on: D("2026-09-25"), amount_cents: 210_000n, contractual_payment_cents: 210_000n });
  assert.equal(full.full, true); assert.equal(full.in_window, true); assert.equal(h.deferral().status, "pending_smdu_entry"); assert.equal(h.deferral().contractual_payment_received_at, "2026-09-25");
  const done = await h.run("smdu.case.submit", { workout: "payment_deferral", partner_servicer_number: "123456789", campaign_id: "PD-2026" }, { now: "2026-09-25T17:00:00.000Z" });
  assert.equal(done.effective_date, "2026-10-01"); assert.equal(h.emitted("payment_deferral.effective").length, 1);
});
test("12.6-T3: (prior deferral) prior deferral effective 2025-11-01 → ineligible until 2026-11-01; prior *disaster* deferral 2025-11-01 → eligible.", () => {
  const base = { months_delinquent: 4, origination_date: D("2021-10-01"), cumulative_deferred_months: 0, months_to_maturity: 348, prior_deferral_effective: D("2025-11-01") };
  const blocked = screen({ ...base, evaluation_date: D("2026-09-20") }); assert.equal(blocked.eligible, false); if (!blocked.eligible) assert.equal(blocked.reason, "INV_FNMA_D23204_PRIOR_DEFERRAL_12M");
  assert.equal(screen({ ...base, evaluation_date: D("2026-10-31") }).eligible, false);   // the day before the anniversary is still inside the 12 months
  assert.equal(screen({ ...base, evaluation_date: D("2026-11-01") }).eligible, true);
  assert.equal(screen({ ...base, evaluation_date: D("2026-09-20"), prior_deferral_was_disaster: true }).eligible, true);
  // The blocked screen can never be turned into an offer (criteria are assertions, not advisories).
  const store = new EntityStore(); const events = new MemoryEventStore(new FixedClock("2026-09-20T14:00:00.000Z"));
  assert.throws(() => offerDeferral({ events, store, actor: AGENT, now: "2026-09-20T14:00:00.000Z" }, { loan_id: LOAN, basis: "streamlined", facts: { ...base, evaluation_date: D("2026-09-20") } }), /INV_FNMA_D23204_PRIOR_DEFERRAL_12M/);
  assert.equal(events.all().length, 0);
});
test("12.6-T4: (cap) cumulative 9 months deferred previously + 4 now = 13 → gate requires the contractual payment and the deferral is limited to 3 months (cap 12) with the 4th installment paid — engine offers the compliant structure or routes to Flex Mod (policy).", () => {
  const r = capStructure({ prior_deferred_months: 9, requested_months: 4 });
  assert.equal(r.cumulative, 13); assert.equal(r.contractual_payment_required, true); assert.equal(r.months_allowed, 3); assert.equal(r.installments_to_pay, 1); assert.equal(r.alternative, "flex_mod");
  const s = screen({ months_delinquent: 4, origination_date: D("2021-10-01"), evaluation_date: D("2026-09-20"), cumulative_deferred_months: 9, months_to_maturity: 348 }); assert.ok(s.eligible && s.contractual_payment_required && s.months_deferred === 3);
  // The compliant structure is what the offer records: 3 months deferred, cumulative 12, one installment to pay, gate on.
  const store = new EntityStore(); const events = new MemoryEventStore(new FixedClock("2026-09-20T14:00:00.000Z"));
  const o = offerDeferral({ events, store, actor: AGENT, now: "2026-09-20T14:00:00.000Z" }, { loan_id: LOAN, basis: "streamlined", facts: { months_delinquent: 4, origination_date: D("2021-10-01"), evaluation_date: D("2026-09-20"), cumulative_deferred_months: 9, months_to_maturity: 348 } });
  assert.equal(o.deferral.months_deferred, 3); assert.equal(o.deferral.cumulative_months_after, 12); assert.equal(o.deferral.installments_to_pay, 1); assert.equal(o.deferral.contractual_payment_required, true);
  assert.equal(o.event.payload.months_deferred, 3); assert.equal(o.event.payload.installments_to_pay, 1);
});
test("12.6-T5: (processing month) evaluation 2026-09-18 (after the 15th) → `processing_month=true`; entry deadline 2026-10-31; borrower not required to pay in October unless the 6-month/cap rule applies.", async () => {
  const tl = timeline(D("2026-09-18"), { processing_month_elected: true });
  assert.equal(tl.processing_month_permitted, true); assert.equal(tl.processing_month, true); assert.equal(tl.entry_deadline, "2026-10-31"); assert.equal(tl.lar_deadline, "2026-10-30"); assert.equal(tl.effective, "2026-11-01"); assert.equal(tl.custodian_by, "2026-11-26");
  const s5 = screen({ months_delinquent: 4, origination_date: D("2021-10-01"), evaluation_date: D("2026-09-18"), cumulative_deferred_months: 0, months_to_maturity: 348 }); assert.ok(s5.eligible && !s5.contractual_payment_required);   // no October payment unless the 6-month/cap rule applies
  // Without an election the evaluation month still governs; an election is refused when the case can be completed by the 15th (D2-3.2-04).
  assert.equal(timeline(D("2026-09-18")).processing_month, false); assert.equal(timeline(D("2026-09-18")).entry_deadline, "2026-09-30");
  assert.throws(() => timeline(D("2026-09-10"), { processing_month_elected: true, completion_on: D("2026-09-14") }), /can be completed by the 15th/);
  assert.equal(timeline(D("2026-09-10"), { processing_month_elected: true, completion_on: D("2026-09-20") }).processing_month, true);
  // On the bus: the election rides on the offer; acceptance fixes the October entry / LAR clocks; completion 2026-10-05 lands in the processing month with no contractual payment required; effective 2026-11-01.
  const facts: DeferralFacts = { months_delinquent: 4, origination_date: D("2021-10-01"), evaluation_date: D("2026-09-18"), cumulative_deferred_months: 0, months_to_maturity: 348 };
  const h = harness("2026-09-18T14:00:00.000Z");
  await offerAcceptComplete(h, { facts, accept_on: "2026-09-18", complete_on: "2026-10-05", processing_month_elected: true });
  assert.equal(h.emitted("payment_deferral.offered")[0]!.payload.processing_month, true); assert.equal(h.emitted("payment_deferral.offered")[0]!.payload.entry_deadline, "2026-10-31");
  const acc = h.emitted("payment_deferral.accepted")[0]!; assert.equal(acc.payload.processing_month, true); assert.equal(acc.payload.entry_deadline, "2026-10-31"); assert.equal(acc.payload.lar_by, "2026-10-30"); assert.equal(acc.payload.contractual_payment_required, false);
  const done = h.emitted("payment_deferral.completed")[0]!; assert.equal(done.payload.processing_month, true); assert.equal(done.payload.entry_deadline, "2026-10-31"); assert.equal(done.payload.completed_on, "2026-10-05"); assert.equal(done.payload.effective_date, "2026-11-01");
  assert.equal(h.deferral().contractual_payment_required, false); assert.equal(h.deferral().contractual_payment_received_at, undefined);   // not required to pay in October
  h.armed("FNMA_D23204_CUSTODIAN_25", "2026-11-26");
  // A case that misses the processing-month deadline is not completed — re-evaluate eligibility next month.
  const late = harness("2026-09-18T14:00:00.000Z");
  await offerAcceptComplete(late, { facts, accept_on: "2026-09-18", complete_on: "2026-11-02", processing_month_elected: true, skip_completion: true });
  await late.rejects("smdu.case.submit", { workout: "payment_deferral", partner_servicer_number: "123456789", campaign_id: "PD-2026" }, /assertEntryByMonthEnd: entered 2026-11-02 after the processing-month deadline 2026-10-31/, { now: "2026-11-02T16:00:00.000Z" });
  assert.equal(late.emitted("smdu.case.submitted").length, 0); assert.equal(late.emitted("payment_deferral.effective").length, 0);
  // An election the 15th still permits completing without is refused at the offer.
  await late.rejects("deferral.screen", { facts: { ...facts, evaluation_date: D("2026-09-10") }, basis: "streamlined", processing_month_elected: true }, /can be completed by the 15th/, { now: "2026-09-10T14:00:00.000Z" });
});
test("12.6-T6: (solicitation clocks) forbearance expired 2026-12-31 without QRPC → solicitation by 2027-01-15; repayment failure at 2026-11-30 → solicitation by 2026-12-15.", () => {
  assert.deepEqual(deferralSolicitationClocks({ forbearance_expired_on: D("2026-12-31"), repayment_failed_month_end: D("2026-11-30") }), { post_forbearance_by: "2027-01-15", post_repayment_by: "2026-12-15" });
});
test("12.6-T7: (Reg X) deferral offered on a complete application → notice carries (c)(1) content and a 14-day window; deemed rejection after the grace releases holds.", async () => {
  const r = deferralOfferOnCompleteApp({ provided_on: D("2026-10-02") });
  // 14-day window (tier ge_90) + the 5-day policy grace of `REGX_1024_41E1_ACCEPT_14` → deemed rejection 2026-10-21.
  assert.equal(r.c1_content, true); assert.equal(r.window_days, 14); assert.equal(r.grace_days, 5); assert.equal(r.accept_by, "2026-10-16"); assert.equal(r.deemed_rejected_on, "2026-10-21"); assert.equal(r.holds_released_on, "2026-10-21"); assert.equal(r.notice, "NTC_FNMA_D23204_DEFERRAL_OFFER");
  // 7-day tier (<90 but >37 days before a sale): `REGX_1024_41E1_ACCEPT_7` with its 3-day grace.
  const seven = deferralOfferOnCompleteApp({ provided_on: D("2026-10-02"), tier: "lt_90" });
  assert.equal(seven.window_days, 7); assert.equal(seven.grace_days, 3); assert.equal(seven.accept_by, "2026-10-09"); assert.equal(seven.deemed_rejected_on, "2026-10-12");
  // On the bus: the offer on a complete application carries the 14-day window; the Evaluation Notice (an offer template) emits `lossmit.offer.sent{tier=ge_90}` which arms the (e)(1) acceptance clock on the provision date; the 12.2 deemed-rejection sweep after the grace releases the holds.
  const h = harness("2026-10-02T14:00:00.000Z");
  const o = await h.run("deferral.screen", { facts: { ...T1_FACTS, evaluation_date: D("2026-10-02") }, basis: "brp", application_complete: true });
  assert.equal((o.deferral as Record<string, unknown>).accept_window_days, 14); assert.equal(h.emitted("payment_deferral.offered")[0]!.payload.application_complete, true); assert.equal(h.emitted("payment_deferral.offered")[0]!.payload.template, "NTC_FNMA_D23204_DEFERRAL_OFFER");
  await h.notice("NTC_FNMA_D23204_DEFERRAL_OFFER", { tier: "ge_90", state: "TX", option: "payment_deferral" });
  const sent = h.emitted("lossmit.offer.sent"); assert.equal(sent.length, 1); assert.equal(sent[0]!.payload.provided_at, "2026-10-02"); assert.equal(sent[0]!.payload.option, "payment_deferral");
  h.armed("REGX_1024_41E1_ACCEPT_14", "2026-10-16"); h.satisfied("FNMA_D2205_EVAL_NOTICE_DEFERRAL_5", "notice.sent");
  h.rt.store.put("foreclosure_holds", "hold-1", { loan_id: LOAN, kind: "lm_offer_pending", status: "active" }, AGENT, h.clock.now());
  const swept = await h.run("lossmit.evaluation.*", { op: "deemed_rejection", option: "payment_deferral", accept_by: "2026-10-16", window_days: 14 }, { process: "12.2", now: "2026-10-21T14:00:00.000Z" });
  assert.equal(swept.deemed_rejected, true); assert.equal(h.rt.store.get("foreclosure_holds", "hold-1")!.data.status, "released");
  assert.equal(h.emitted("payment_deferral.accepted").length, 0, "no acceptance was derived from a deemed rejection");
});
test("12.6-T8: (ledger) postings balance; IB UPB equals the scheduled balance; `deferred_principal` = $7,370.68; payoff statement shows the NIB line.", async () => {
  const r = deferralLedger({ pi_cents: 158_017n, months_deferred: 4, escrow_advances_cents: 105_000n, servicing_advances_cents: 0n, late_charges_cents: 25_200n, pre_deferral_ib_upb_cents: PRE_DEFERRAL_UPB, scheduled_ib_upb_cents: SCHEDULED_UPB });
  assert.equal(r.balanced, true); assert.equal(r.deferred_principal_cents, 737_068n);
  // The principal portions of the four deferred installments are credited to `principal`, the interest portions to `interest_due`, so the IB UPB lands on the amortized balance as though they had been paid.
  assert.equal(r.principal_portion_cents, PRE_DEFERRAL_UPB - SCHEDULED_UPB); assert.equal(r.principal_portion_cents + r.interest_portion_cents, 4n * 158_017n);
  assert.equal(r.ib_upb_cents, SCHEDULED_UPB); assert.equal(r.ib_upb_equals_scheduled, true); assert.equal(r.postings.find((p) => p.account === "principal")!.credit, r.principal_portion_cents);
  assert.ok(r.postings.every((p) => p.rule_ref.startsWith("12.6.deferral"))); assert.deepEqual(r.payoff_lines[1], { line: "Deferred principal (non-interest-bearing)", cents: 737_068n });
  assert.throws(() => deferralLedger({ pi_cents: 158_017n, months_deferred: 4, escrow_advances_cents: 0n, servicing_advances_cents: 0n, late_charges_cents: 0n, pre_deferral_ib_upb_cents: PRE_DEFERRAL_UPB, scheduled_ib_upb_cents: PRE_DEFERRAL_UPB + 1n }), /not reachable/);
  // NIB math is code: the bus refuses a caller-supplied NIB or late charges in the NIB, and the reported NIB is read from the stored breakdown.
  const h = harness();
  await h.refused("ledger.arrears_breakdown", { pi_cents: 158_017n, months_deferred: 4, include_late_charges_in_nib: true }, "NIB_EXCLUDES_LATE_CHARGES");
  await h.refused("ledger.arrears_breakdown", { pi_cents: 158_017n, months_deferred: 4, nib_cents: 762_268n }, "NIB_EXCLUDES_LATE_CHARGES");
  const led = await h.run("ledger.arrears_breakdown", { pi_cents: 158_017n, months_deferred: 4, escrow_advances_cents: 105_000n, servicing_advances_cents: 0n, late_charges_cents: 25_200n, pre_deferral_ib_upb_cents: PRE_DEFERRAL_UPB, scheduled_ib_upb_cents: SCHEDULED_UPB });
  assert.equal(led.deferred_principal_cents, 737_068n); assert.equal(led.ib_upb_cents, SCHEDULED_UPB);
  await h.rejects("investor.report_contractual_payments", { deferral_ledger_id: led.deferral_ledger_id, nib_cents: 762_268n }, /NIB_FROM_LEDGER_ONLY/);
  const rep = await h.run("investor.report_contractual_payments", { deferral_ledger_id: led.deferral_ledger_id });
  assert.equal((rep as unknown as DomainEvent).payload.nib_cents, 737_068n); assert.equal((rep as unknown as DomainEvent).payload.months, 4);
});
test("12.6-T9: (SMDU outage) B2B failure on 2026-09-28 → portal task filed; operator completes 2026-09-29; case evidence attached.", () => {
  const tl = timeline(D("2026-09-20")); const r = smduDeferralOutage({ evaluation_on: D("2026-09-20"), failed_on: D("2026-09-28"), operator_completed_on: D("2026-09-29"), entry_deadline: tl.entry_deadline, evidence_document_id: "doc-smdu-1" });
  assert.deepEqual(r.portal_task, { kind: "human_portal_task", filed_on: "2026-09-28" }); assert.equal(r.completed_on, "2026-09-29"); assert.equal(r.within_entry_deadline, true); assert.deepEqual(r.case_evidence, { document_id: "doc-smdu-1", attached: true });
  // The operator's 2026-09-29 completion is the last day the September entry deadline allows before the LAR cut-off; 2026-10-01 would miss it.
  assert.equal(smduDeferralOutage({ evaluation_on: D("2026-09-20"), failed_on: D("2026-09-28"), operator_completed_on: D("2026-10-01"), entry_deadline: tl.entry_deadline, evidence_document_id: "doc-smdu-1" }).within_entry_deadline, false);
});
test("12.6-T10: (recording state) `deferral_recording=true` → recordable agreement executed by `signing_officer`, e-recorded, certified copy to custodian ≤25 days, original ≤5 BD after receipt.", async () => {
  // A deferral's 25-day custodian clock anchors on the effective date (D2-3.2-04; `FNMA_D23204_CUSTODIAN_25`): effective 2026-10-01 → 2026-10-26.
  const r = recordableAgreement({ recording_required: true, executed_by_role: "signing_officer", borrower_signed_on: D("2026-09-25"), custodian_anchor: { basis: "effective_date", on: D("2026-10-01") }, erecorded_on: D("2026-10-02"), recorded_original_received_on: D("2026-10-20") });
  assert.equal(r.allowed, true); assert.equal(r.certified_copy_to_custodian_by, "2026-10-26"); assert.equal(r.erecorded_on, "2026-10-02"); assert.equal(r.original_to_custodian_by, "2026-10-27"); assert.equal(r.unrecorded_original_by, null);
  assert.equal(recordableAgreement({ recording_required: true, executed_by_role: "ops_analyst", borrower_signed_on: D("2026-09-25"), custodian_anchor: { basis: "effective_date", on: D("2026-10-01") } }).allowed, false);
  // On the bus: the recordable deferral completes 2026-09-22 (effective 2026-10-01); an agent cannot e-record an unexecuted agreement; the signing_officer's execution goes to e-recording; the certified copy closes the 25-day clock; the recorder's original opens the 5-BD clock (received Tue 2026-10-20 → Tue 2026-10-27) which the original's delivery closes.
  const h = harness();
  await offerAcceptComplete(h, { accept_on: "2026-09-22", complete_on: "2026-09-22", recording_required: true });
  assert.equal(h.deferral().recording_required, true); h.armed("FNMA_D23204_CUSTODIAN_25", "2026-10-26");
  await h.refused("erecording.submit", { document_id: "doc-agr-1" }, "SIGNING_OFFICER_EXECUTES");
  const pkg = await (h.rt.ports.erecording as FakeErecording).createPackage({ releaseTaskId: "doc-agr-1", attempt: 1, county: "Dallas", state: "TX", documentSha256: "sha-agr-1" }, h.clock.now());
  const rec = await h.run<{ status: string }>("erecording.submit", { document_id: "doc-agr-1", package_id: pkg.packageId, officer_signature_date: "2026-09-25" }, { actor: SIGNING_OFFICER, now: "2026-10-02T10:00:00.000Z" });
  assert.equal(rec.status, "recorded"); assert.equal(h.emitted("erecording.submitted").length, 1); assert.equal(h.emitted("erecording.submitted")[0]!.payload.officer_signature_date, "2026-09-25");
  assert.throws(() => confirmCustodianDelivery(h.env(), { loan_id: LOAN, document: "executed_copy", confirmed_on: D("2026-10-05"), receipt_id: "cust-x" }), /certified copy, then the recorded original/);
  assert.throws(() => confirmCustodianDelivery(h.env(), { loan_id: LOAN, document: "recorded_original", confirmed_on: D("2026-10-05"), receipt_id: "cust-x" }), /recorded original has not been received/);
  const cert = confirmCustodianDelivery(h.env(), { loan_id: LOAN, document: "certified_copy", confirmed_on: D("2026-10-05"), receipt_id: "cust-1" });
  assert.equal(cert.complete, false); h.satisfied("FNMA_D23204_CUSTODIAN_25", "custodian.delivery.confirmed"); assert.equal(h.deferral().status, "completed");
  const orig = recordedOriginalReceived(h.env(), { loan_id: LOAN, document_id: "doc-rec-1", received_on: D("2026-10-20") });
  assert.equal(orig.original_to_custodian_by, "2026-10-27"); h.armed("FNMA_D23204_RECORDED_ORIGINAL_5BD", "2026-10-27");
  const done = confirmCustodianDelivery(h.env(), { loan_id: LOAN, document: "recorded_original", confirmed_on: D("2026-10-22"), receipt_id: "cust-2" });
  assert.equal(done.complete, true); assert.equal(h.deferral().status, "documented"); assert.equal(h.deferral().custodian_delivered_at, "2026-10-22");
  h.satisfied("FNMA_D23204_RECORDED_ORIGINAL_5BD", "custodian.delivery.confirmed");
  // An unrecorded deferral never takes a certified copy or a recorded original.
  const u = harness(); await offerAcceptComplete(u, { accept_on: "2026-09-22", complete_on: "2026-09-22" });
  assert.throws(() => confirmCustodianDelivery(u.env(), { loan_id: LOAN, document: "certified_copy", confirmed_on: D("2026-10-05"), receipt_id: "c" }), /only for a recorded agreement/);
  assert.throws(() => recordedOriginalReceived(u.env(), { loan_id: LOAN, document_id: "d", received_on: D("2026-10-20") }), /not a recordable agreement/);
});

test("12.6 TX_50A6_DEFERRAL_NOTICE_7BD: a Texas §50(a)(6) allegation (4.5) opens the 7 servicer-business-day Form 20 clock (2026-10-05 → 2026-10-15, Columbus Day skipped) and the 60-day cure; `fnma.legal.notified{form=form_20}` closes it", async () => {
  const h = harness("2026-10-05T14:00:00.000Z");
  await offerAcceptComplete(h, { accept_on: "2026-09-22", complete_on: "2026-09-22" });
  assert.throws(() => notifyFnmaLegal(h.env(), { loan_id: LOAN, case_id: "cmp-tx-1" }), /no §50\(a\)\(6\) allegation on file/);
  // The 4.5 complaint command's allegation event (section04 escalateTx50a6): case-scoped, carrying the borrower's notice date.
  h.events.append({ type: "complaint.tx_50a6_defect.alleged", loanId: LOAN, aggregate: { kind: "case", id: "cmp-tx-1" }, actor: { kind: "agent", id: "case" }, payload: { case_id: "cmp-tx-1", notice_date: "2026-10-05", cure_by: "2026-12-04", allegation: "fee cap" } });
  h.armed("TX_50A6_DEFERRAL_NOTICE_7BD", "2026-10-15");
  assert.throws(() => notifyFnmaLegal(h.env(), { loan_id: LOAN, case_id: "cmp-tx-1", notified_on: D("2026-10-04") }), /cannot be notified \(2026-10-04\) before the borrower's notice/);
  const n = notifyFnmaLegal(h.env(), { loan_id: LOAN, case_id: "cmp-tx-1", notified_on: D("2026-10-08"), ack_id: "fnma-legal-ack-1" });
  assert.equal(n.due_by, "2026-10-15"); assert.equal(n.cure_by, "2026-12-04"); assert.equal(n.late, false);
  assert.equal(n.event.payload.form, "form_20"); assert.equal(n.event.payload.deferral_id, h.deferral().id); assert.equal(n.event.payload.notice_date, "2026-10-05");
  h.satisfied("TX_50A6_DEFERRAL_NOTICE_7BD", "fnma.legal.notified");
  assert.ok(eventMatches(parseEventPattern("`fnma.legal.notified{form=form_20}`")!, n.event));
  // The same filing on 2026-10-16 is late.
  assert.equal(notifyFnmaLegal(h.env(), { loan_id: LOAN, case_id: "cmp-tx-1", notified_on: D("2026-10-16") }).late, true);
});

test("12.6 FNMA_D23206_POSTDEFERRAL_FLEX_SOLICIT_75: the 11.1 day-60 milestone within 6 months of the deferral's effective date without QRPC emits `payment_deferral.redelinquent` and arms the day-75 streamlined solicitation; `notice.sent{template=NTC_FNMA_D23206_SOLICIT_STREAMLINED}` closes it", async () => {
  const h = harness();
  await offerAcceptComplete(h, { accept_on: "2026-09-22", complete_on: "2026-09-22" });
  assert.equal(h.deferral().effective_date, "2026-10-01");
  // The counter job: first post-deferral installment 2026-12-01 unpaid; day 60 falls on 2027-01-30 (Fannie Mae day count supplied by 5.7).
  const m = delinquencyMilestone({ today: D("2027-01-30"), earliest_unpaid_due: D("2026-12-01"), fnma_delinquency_days: 60, qrpc_established: false });
  assert.equal(m.milestone, 60); assert.equal(daysBetween(D("2026-12-01"), D("2027-01-30")), 60);
  h.clock.set("2027-01-30T09:00:00.000Z");
  for (const e of m.events) h.events.append({ type: e.type, loanId: LOAN, actor: { kind: "system", id: "delinquency-counter" }, payload: e.payload });
  const re = h.emitted("payment_deferral.redelinquent"); assert.equal(re.length, 1);
  assert.equal(re[0]!.payload.fnma_day, 60); assert.equal(re[0]!.payload.post_deferral_within_6m, true); assert.equal(re[0]!.payload.qrpc, false); assert.equal(re[0]!.payload.day_60_date, "2027-01-30"); assert.equal(re[0]!.payload.solicit_by, "2027-02-14"); assert.equal(re[0]!.payload.effective_date, "2026-10-01");
  h.armed("FNMA_D23206_POSTDEFERRAL_FLEX_SOLICIT_75", "2027-02-14");   // day 60 + 15 = day 75
  await h.notice("NTC_FNMA_D23206_SOLICIT_STREAMLINED", {}, );
  h.satisfied("FNMA_D23206_POSTDEFERRAL_FLEX_SOLICIT_75", "notice.sent");
  // Outside the 6 months (effective 2026-10-01 → window closes 2027-04-01), or with QRPC, the row does not arm; a day-45 milestone is not the trigger.
  assert.equal(postDeferralRedelinquency(h.env(), { loan_id: LOAN, fnma_day: 60, on: D("2027-04-02"), qrpc: false })!.payload.post_deferral_within_6m, false);
  assert.equal(postDeferralRedelinquency(h.env(), { loan_id: LOAN, fnma_day: 60, on: D("2027-03-15"), qrpc: true })!.payload.qrpc, true);
  assert.equal(postDeferralRedelinquency(h.env(), { loan_id: LOAN, fnma_day: 45, on: D("2027-01-15"), qrpc: false }), null);
  assert.equal(h.timers.byCode("FNMA_D23206_POSTDEFERRAL_FLEX_SOLICIT_75").length, 1);
  // A loan without an effective deferral is left alone by the watcher.
  const other = harness(); other.events.append({ type: "loan.delinquency.day_reached", loanId: LOAN, actor: { kind: "system", id: "delinquency-counter" }, payload: { day: 60, fnma_day: 60, on: "2027-01-30", qrpc_established: false } });
  assert.equal(other.emitted("payment_deferral.redelinquent").length, 0);
});

test("12.6 D2-3.2-04 criteria 5, 10 and 11: seasoning ≥12 months, no active plan / retention offer / trial / approved liquidation / recourse, no failed non-disaster trial or non-disaster modification within 12 months", () => {
  const base = { months_delinquent: 4, origination_date: D("2021-10-01"), evaluation_date: D("2026-09-20"), cumulative_deferred_months: 0, months_to_maturity: 348 };
  const young = screen({ ...base, origination_date: D("2025-10-01") }); assert.equal(young.eligible, false); if (!young.eligible) assert.equal(young.reason, "INV_FNMA_D23204_SEASONING_12M");
  assert.equal(screen({ ...base, origination_date: D("2025-09-20") }).eligible, true);   // exactly 12 months before the evaluation date
  for (const a of ["active_repayment_plan", "current_retention_offer", "active_trial_period_plan", "approved_liquidation", "recourse_or_indemnification"] as const) { const r = screen({ ...base, active_arrangements: [a] }); assert.equal(r.eligible, false); if (!r.eligible) assert.equal(r.reason, "INV_FNMA_D23204_CONFLICTING_ARRANGEMENT"); }
  const trial = screen({ ...base, last_failed_trial_on: D("2026-01-15") }); assert.equal(trial.eligible, false); if (!trial.eligible) assert.equal(trial.reason, "INV_FNMA_D23204_TRIAL_OR_MOD_12M");
  const mod = screen({ ...base, last_modification_effective: D("2025-11-01") }); assert.equal(mod.eligible, false); if (!mod.eligible) assert.equal(mod.reason, "INV_FNMA_D23204_TRIAL_OR_MOD_12M");
  assert.equal(screen({ ...base, last_failed_trial_on: D("2025-09-01"), last_modification_effective: D("2025-08-01"), active_arrangements: [] }).eligible, true);
});

test("12.6 worked figures: P&I $1,580.17 × 4 + tax advance $1,050.00 = $7,370.68 NIB; late charges 4 × $63.00 = $252.00 waived; shortage $1,860.00 → $31.00/month; T&I $520.00 → payment $2,131.17", () => {
  assert.equal(nib(158017n, 4, 105000n, 0n), 737068n);
  assert.equal(arrears({ piti_cents: 210000n, unpaid_installments: 4, late_charge_cents: 6300n, late_charges: 4 }).late_charges_cents, 25200n);
  assert.deepEqual(newPayment(158017n, 52000n, 186000n), { shortage_monthly_cents: 3100n, payment_cents: 213117n });
});

test("12.6 completion is refused without the SMDU submission and outside the 12.6 offer path a submitted case is recorded as-is (evaluation month = completion month)", () => {
  const store = new EntityStore(); const events = new MemoryEventStore(new FixedClock("2026-10-05T14:00:00.000Z")); const env: DeferralEnv = { events, store, actor: AGENT, now: "2026-10-05T14:00:00.000Z" };
  assert.throws(() => completeDeferral(env, { loan_id: LOAN }), /submit the PAYMENT_DEFERRAL case first/);
  events.append({ type: "smdu.case.submitted", loanId: LOAN, actor: AGENT, payload: { workout: "payment_deferral", submitted_on: "2026-10-05", case_id: "SMDU-9", campaign_id: null } });
  assert.throws(() => completeDeferral(env, { loan_id: LOAN }), /campaign ID/);
  events.append({ type: "smdu.case.submitted", loanId: LOAN, actor: AGENT, payload: { workout: "payment_deferral", submitted_on: "2026-10-05", case_id: "SMDU-9", campaign_id: "PD-2026" } });
  const c = completeDeferral(env, { loan_id: LOAN });
  assert.equal(c.effective_date, "2026-11-01"); assert.equal(c.entry_deadline, "2026-10-31"); assert.equal(c.processing_month, false); assert.equal(c.deferral.smdu_case_id, "SMDU-9"); assert.equal(c.deferral.status, "completed");
  assert.throws(() => completeDeferral(env, { loan_id: LOAN }), /already completed/);
});
