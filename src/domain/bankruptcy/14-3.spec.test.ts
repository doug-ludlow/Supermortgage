// 14.3 Periodic statement in bankruptcy
// spec/sections/14-bankruptcy/14-3-periodic-statement-in-bankruptcy.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { cents, formatCents } from "../../kernel/money/cents.ts";
import { ch7Content, ch13Statement, ch13Disclosures, dischargeTransition, resumeRequest, ceaseRequest, planTreatmentChanged, addressingDecision, petitionTransition, earlyInterventionAtPetition, laterDelinquencyDuringCase, earlyInterventionRecord, earlyInterventionEvaluation, statementResumption, dismissal, postDischargePayment, reaffirmationVariant, reaffirmationRescissionEnds, suppressCommunication, communicationsMatrix, communicationsMatrixRows, COMMUNICATIONS_MATRIX_VERSION, postpetitionSplit, statementCycle, transitionAfterEvent, statementModeGuard, classifyRequest, toStatementMode, STATEMENT_MODES, EI_EVENT, RESUMPTION_EVENT, type Ch13Receipt } from "./ops-14-3.ts";
import * as C from "./case.ts";
import { balanceAfter } from "../lossmit/flexmod.ts";
import { levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { EVALUATORS_14_3 } from "./evaluators-14-3.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { eventMatches, MemoryEventStore, FixedClock, SYSTEM, type DomainEvent, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine, computeDue, defaultAnchorResolver } from "../../kernel/timers/engine.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import type { CommandContext } from "../../app/commands.ts";
import { EscalationService } from "../../app/escalations.ts";
import { TOOLS_14_3 } from "../../app/tools/section14-3.ts";
import { counterRun } from "../early-intervention/ops.ts";

const BK_EI = "NTC_REGX_39B_EARLY_INTERVENTION_BK";
const LOAN = "BK-13-A";
const BK_OPS: Actor = { kind: "agent", id: "bankruptcy-ops" };
const registry = () => { const reg = buildRegistry(); publishAuthored(reg); return reg; };
const eiVersion = () => { const reg = registry(); return { reg, v: reg.activeVersion(BK_EI, D("2026-10-20"))! }; };
/**
 * The 14.3 tools against the platform they run on: an event store, a TimerEngine over the overridden registry (arming only 14.3 rows)
 * and an entity store — so a tool's event either arms/satisfies the registry row or the test fails (no hand-built payloads).
 */
const rig = (iso: string, processes: readonly string[] = ["14.3"]) => {
  const clock = new FixedClock(iso); const events = new MemoryEventStore(clock); const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes });
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const ctx = (): CommandContext => ({ loanId: LOAN, events, ledger: new MemoryLedger(), timers, clock, decide: () => {}, actor: BK_OPS, now: clock.now() });
  const call = (name: string, input: ToolInput) => TOOLS_14_3.find((t) => t.name === name)!.handler(input, ctx(), rt) as Record<string, unknown>;
  const last = (type: string): DomainEvent => { const e = events.all().filter((x) => x.type === type).at(-1); assert.ok(e, `${type} was emitted`); return e!; };
  const emit = (type: string, payload: Record<string, unknown>): DomainEvent => events.append({ type, loanId: LOAN, actor: SYSTEM, payload });
  return { clock, events, timers, rt, call, last, emit, reg: loadOverriddenRegistry() };
};
const dueFromRegistry = (code: string, ev: DomainEvent): string | undefined => { const def = loadOverriddenRegistry().get(code)!; assert.ok(eventMatches(def.triggerPattern!, ev), `${code} is armed by ${ev.type}`); return computeDue(def.offsetParsed, defaultAnchorResolver(def, ev)!, Date.parse(ev.occurredAt)).dueDate; };
/** Fixture BK-13-A, direct-pay example B: the Feb 1, 2027 statement (cut-off 2027-01-17) with the scheduled split for payment #43. */
const exampleB = (over: Partial<Parameters<typeof ch13Statement>[0]> = {}) => {
  const split = postpetitionSplit({ original_upb_cents: 32_500_000n, rate_pct: "6.500", term_months: 360, payment_number: 43, escrow_cents: 75_250n });
  const receipts: Ch13Receipt[] = [{ on: D("2027-01-15"), cents: 150_000n, source: "debtor", applied_to: "unapplied" }];
  return ch13Statement({ statement_date: D("2027-01-17"), amount_due_date: D("2027-02-01"), chapter: "13", case_number: "4:26-bk-31234", installment: split, postpetition_unpaid: [{ due: D("2026-12-01"), cents: 280_672n }, { due: D("2027-01-01"), cents: 280_672n }], allowed_noticed_fees_unpaid_cents: 0n, postpetition_fees_since_last_cents: 0n, receipts_since_last: receipts, ytd_received_cents: 150_000n, suspense_cents: 150_000n, prepetition: { received_since_last_cents: 0n, received_since_filing_cents: 0n, arrearage_cents: 1_424_194n, bar_date_passed: true }, trustee_pays_postpetition: false, trustee_pays_arrearage: true, ...over });
};
/** Chapter 7 example C: Jun 1–Dec 1, 2026 unpaid (the Oct 5 payment cured May 1), pre-petition late charges $410.84, discharge 2026-12-15, statement date 2026-12-17. */
const exampleC = () => ch7Content({ statement_date: D("2026-12-17"), next_due: D("2027-01-01"), installment_cents: 269_922n, unpaid_due_dates: ["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01"].map(D), prepetition_late_charges_cents: 41_084n, status: "discharged", chapter: "7", case_number: "4:26-bk-31240" });

test("14.3-T1: Given petition 2026-09-08 (before the Sept-16 courtesy end) and no statement yet rendered for the Oct-1 cycle, then that cycle is recorded `single_statement_skip` and the Nov-1 cycle statement (due by 2026-10-20) renders `NTC_REGZ_41_STMT_BK12_13`.", () => {
  const p = petitionTransition({ petition_on: D("2026-09-08"), chapter: "13", rendered_for_open_cycle: false, event_id: "evt-petition-2026-09-08" });
  assert.equal(p.mode_after, "modified_ch12_13");
  // the cycle open on the petition date (due 2026-09-01) shows the Oct-1 amount; its courtesy period ends Sept 16 — the petition precedes it and nothing was rendered → skip (rule 1(d); 14.3-Q1)
  assert.equal(p.transition.skippable, true); assert.equal(p.transition.decision, "skip_this_cycle"); assert.match(p.transition.basis, /\(A\)\(1\) becomes subject to \(f\)/);
  assert.equal(p.transition.skipped_cycle!.courtesy_period_end, "2026-09-16"); assert.equal(p.transition.skipped_cycle!.amount_due_date, "2026-10-01");
  // that cycle is recorded `single_statement_skip` (logged with the event id); the Nov-1 cycle statement (due by 2026-10-20) renders the H-30(F) variant
  const [skipped, resumed] = p.records; assert.equal(p.records.length, 2);
  assert.deepEqual([skipped!.recorded_mode, skipped!.statement, skipped!.template, skipped!.basis_event_id, skipped!.cycle.amount_due_date], ["single_statement_skip", "skipped", null, "evt-petition-2026-09-08", "2026-10-01"]);
  assert.deepEqual([resumed!.recorded_mode, resumed!.statement, resumed!.template, resumed!.cycle.amount_due_date, resumed!.cycle.statement_due_by], ["modified_ch12_13", "rendered", "NTC_REGZ_41_STMT_BK12_13", "2026-11-01", "2026-10-20"]);
  assert.deepEqual(p.status, { mode: "single_statement_skip", single_statement_used_for_cycle: "2026-10-01", resume_from_cycle: "2026-11-01", basis_event_id: "evt-petition-2026-09-08" });
  // the template the resumed cycle renders is authored (7.1, H-30(F)) and active for the Oct-20 statement date
  const v = registry().activeVersion("NTC_REGZ_41_STMT_BK12_13", D("2026-10-20"))!; assert.ok(v);
  const out = render(v.source, v.samplePayload); assert.match(out.text, /Post-petition amount due/); assert.match(out.text, /informational purposes only/); assert.equal(evaluateChecklist(v, v.samplePayload, out).passed, true);
  // had the Oct-1 statement already been rendered, it goes out unmodified and the Nov-1 statement is the skipped one (comment 41(e)(5)(iv)(B)-1)
  const rendered = petitionTransition({ petition_on: D("2026-09-08"), chapter: "13", rendered_for_open_cycle: true });
  assert.equal(rendered.transition.decision, "send_unmodified_skip_next");
  assert.deepEqual(rendered.records.map((r) => [r.cycle.amount_due_date, r.recorded_mode, r.statement, r.template]), [["2026-10-01", "standard", "sent_unmodified", "NTC_REGZ_41_STMT_STD"], ["2026-11-01", "single_statement_skip", "skipped", null], ["2026-12-01", "modified_ch12_13", "rendered", "NTC_REGZ_41_STMT_BK12_13"]]);
  assert.equal(rendered.status.single_statement_used_for_cycle, "2026-11-01");
  // a Chapter 7 petition resumes with the H-30(E) variant; the spec enum is what bk_statement_status stores
  assert.equal(petitionTransition({ petition_on: D("2026-09-08"), chapter: "7", rendered_for_open_cycle: false }).records[1]!.template, "NTC_REGZ_41_STMT_BK7_11");
  assert.ok(STATEMENT_MODES.includes("exempt_plan_surrender") && STATEMENT_MODES.includes("exempt_charged_off_n_a")); assert.equal(toStatementMode("exempt_surrender_plan"), "exempt_plan_surrender");
});
test("14.3-T2: Given the Feb-1-2027 cycle in example B, then amount due = $8,420.16, past-due post-petition = $5,613.44, suspense disclosed $1,500.00 with the $1,306.72 (d)(5) text, pre-petition arrearage $14,241.94, the >45-day sentence present (Dec 1 unpaid 47 days), and no late-fee line or delinquency box.", () => {
  const s = exampleB();
  assert.equal(s.template, "NTC_REGZ_41_STMT_BK12_13"); assert.equal(s.amount_due_date, "2027-02-01"); assert.equal(s.installment_cents, 280_672n);
  // amount due = post-petition installment + past-due post-petition installments (FIFO on the post-petition ledger) + allowed noticed fees (none)
  assert.equal(s.amount_due_cents, 842_016n); assert.equal(s.amount_due_display, "$8,420.16"); assert.equal(s.past_due_postpetition_cents, 561_344n); assert.equal(s.past_due_postpetition_display, "$5,613.44");
  assert.equal(s.amount_due_cents, s.installment_cents + s.past_due_postpetition_cents + s.explanation.allowed_noticed_fees_unpaid_cents);
  // suspense disclosed under (d)(3)/(d)(5), never netted, with the (d)(5) text
  assert.equal(s.suspense_disclosed, true); assert.equal(s.past_payments.unapplied_held_cents, 150_000n); assert.equal(s.past_payments.unapplied_since_last_cents, 150_000n);
  assert.equal(s.shortfall_cents, 130_672n); assert.equal(s.d5_partial_payment_text, "We need $1,306.72 more to apply a full post-petition payment.");
  assert.deepEqual(s.transactions, ["01/15/2027 Payment received — $1,500.00 — held in unapplied funds (post-petition)"]);
  // pre-petition arrearage block: receipts since last statement / since filing and the balance, formatted (not raw cents)
  assert.equal(s.prepetition_arrearage.balance_cents, 1_424_194n); assert.equal(s.prepetition_arrearage.display, "$14,241.94"); assert.equal(s.prepetition_arrearage.received_since_last_display, "$0.00"); assert.equal(s.prepetition_arrearage.received_since_filing_display, "$0.00"); assert.equal(s.prepetition_arrearage.acknowledgment_shown, false);
  // (f)(3)(vi)(E): Dec 1 unpaid 47 days on the post-petition ledger → the >45-day sentence; the trustee-pays-arrearage and attorney/trustee sentences
  assert.equal(s.postpetition_days_delinquent, 47); assert.equal(s.over_45_sentence, true);
  assert.ok(s.disclosures.includes("We have not received all the payments that became due since you filed for bankruptcy."));
  assert.ok(s.disclosures.includes("The amount due includes only post-petition amounts.")); assert.ok(s.disclosures.some((d) => /trustee pays the pre-petition arrearage/.test(d))); assert.ok(s.disclosures.some((d) => /attorney or the trustee/.test(d)));
  // (f)(3)(vi)(A)–(E) as applicable: direct-pay example B carries (C) without the "pay the trustee" sentence (B); a conduit plan (trustee pays post-petition) carries (B), and the arrearage aside only when the trustee pays the arrearage
  assert.ok(s.disclosures.some((d) => /may not reflect payments made to the trustee and may not be consistent with the trustee's records/.test(d))); assert.ok(!s.disclosures.some((d) => /send those payments to the trustee/.test(d)));
  const conduit = exampleB({ trustee_pays_postpetition: true, trustee_pays_arrearage: false });
  assert.ok(conduit.disclosures.some((d) => /post-petition mortgage payments to the trustee.*send those payments to the trustee, not to us/.test(d))); assert.ok(!conduit.disclosures.some((d) => /trustee pays the pre-petition arrearage/.test(d))); assert.ok(conduit.disclosures.some((d) => /may not reflect payments made to the trustee/.test(d)));
  assert.equal(ch13Disclosures({ trustee_pays_postpetition: false, trustee_pays_arrearage: false, over_45: false }).length, 3); assert.equal(ch13Disclosures({ trustee_pays_postpetition: true, trustee_pays_arrearage: true, over_45: true }).length, 5);
  // no late-fee line, no delinquency box, no foreclosure language; the (f)(2) legend
  assert.equal(s.late_fee_line, false); assert.equal(s.delinquency_box, false); assert.equal(s.foreclosure_language, false); assert.equal(s.informational_only, true);
  assert.equal(s.legend, "You are a debtor in a Chapter 13 bankruptcy case (No. 4:26-bk-31234) — this statement is for informational purposes only.");
  // the figures flow into 7.1's H-30(F) template and pass its checklist
  const v = registry().activeVersion("NTC_REGZ_41_STMT_BK12_13", D("2027-01-20"))!;
  const payload = { ...v.samplePayload, due_date: "2027-02-01", amount_due_cents: s.amount_due_cents, post_petition_due_cents: s.amount_due_cents, principal_cents: s.explanation.principal_cents, interest_cents: s.explanation.interest_cents, escrow_cents: s.explanation.escrow_cents, prepetition_arrearage_cents: s.prepetition_arrearage.balance_cents, prepetition_paid_cents: s.prepetition_arrearage.received_since_filing_cents, prepetition_remaining_cents: s.prepetition_arrearage.balance_cents, payments_since_last_cents: s.past_payments.since_last_statement_cents, trustee_payments_cents: s.past_payments.trustee_since_last_cents, ytd_cents: s.past_payments.ytd_cents, suspense_held_cents: s.past_payments.unapplied_held_cents, transactions: [{ date: "2027-01-15", description: "Payment received — held in unapplied funds (post-petition)", amount_cents: 150_000n }] };
  const out = render(v.source, payload); assert.match(out.text, /Post-petition amount due \$8,420\.16/); assert.match(out.text, /remaining \$14,241\.94/); assert.match(out.text, /unapplied funds currently held \$1,500\.00/); assert.doesNotMatch(out.text, /late fee/i); assert.equal(evaluateChecklist(v, payload, out).passed, true);
  // until the POC is computed the block carries the "amount not yet determined" acknowledgment; after the bar date the figure is required (comment (v)-1)
  const undetermined = exampleB({ prepetition: { received_since_last_cents: 0n, received_since_filing_cents: 0n, arrearage_cents: null, bar_date_passed: false } });
  assert.equal(undetermined.prepetition_arrearage.display, "amount not yet determined"); assert.equal(undetermined.prepetition_arrearage.acknowledgment_shown, true); assert.equal(undetermined.prepetition_arrearage.defect, null);
  assert.match(exampleB({ prepetition: { received_since_last_cents: 0n, received_since_filing_cents: 0n, arrearage_cents: null, bar_date_passed: true } }).prepetition_arrearage.defect!, /bar date/);
  // a Dec 1 paid on time would leave Jan 1 unpaid 16 days: no >45-day sentence
  assert.equal(exampleB({ postpetition_unpaid: [{ due: D("2027-01-01"), cents: 280_672n }] }).over_45_sentence, false);
});
test("14.3-T3: Given Chapter 7 example C with discharge 2026-12-15, then the Jan-1-2027 statement shows amount to bring current $19,305.38, amount due $22,004.60, the account history for Jul–Dec, the discharge legend, and omits the delinquency start date and risk language; no cycle is skipped at discharge.", () => {
  // example C: Jun 1–Dec 1 unpaid (the Oct 5 payment cured May 1), pre-petition late charges $410.84, discharge 2026-12-15, statement date 2026-12-17
  const c = exampleC();
  assert.equal(c.template, "NTC_REGZ_41_STMT_BK7_11");
  assert.equal(c.unpaid_installment_count, 7); assert.equal(c.unpaid_installments_cents, 1_889_454n); assert.equal(c.amount_to_bring_current_cents, 1_930_538n); assert.equal(c.amount_due_cents, 2_200_460n);
  assert.deepEqual(c.account_history.map((h) => h.due), ["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01"]);
  assert.ok(c.account_history.every((h) => h.remaining_cents === 269_922n && /\$2,699\.22 remaining$/.test(h.line)), "Jul–Dec each $2,699.22 remaining");
  assert.equal(c.regx_days_delinquent, 199); assert.equal(c.new_late_charges_cents, 0n);
  assert.match(c.status_legend, /received a discharge/); assert.match(c.status_legend, /informational purposes only and is not an attempt to collect a debt from you personally/);
  assert.equal(c.delinquency_start_date_shown, false); assert.equal(c.risk_of_foreclosure_shown, false); assert.equal(c.first_notice_statement_shown, false); assert.equal(c.late_fee_line, false);
  assert.deepEqual(c.omitted, ["d1ii_late_fee", "d8i_delinquency_start_date", "d8ii_risk_of_foreclosure", "d8v_first_notice_statement"]);
  assert.ok(c.retained.includes("d8iii_account_history") && c.retained.includes("d8vi_amount_to_bring_current") && c.retained.includes("d8vii_counselor_reference"));
  // no single-statement exemption at discharge: the loan was already under (f) since the petition (comment 41(f)-1)
  const t = dischargeTransition({ petition_on: D("2026-09-08"), discharge_on: D("2026-12-15"), reaffirmed: false, chapter: "7", rendered_for_open_cycle: false });
  assert.equal(t.skippable, false); assert.equal(t.decision, "none"); assert.equal(t.skipped_cycle, null); assert.equal(t.resume_mode, "modified_ch7_11"); assert.match(t.basis, /41\(f\)-1/);
  // the petition itself was the (A)(1) event: Sept-16 courtesy end, nothing rendered → the Oct-1 statement (due by Sep 20) skipped, Nov-1 statement due by Oct 20 (14.3-T1)
  const pet = transitionAfterEvent({ event_on: D("2026-09-08"), mode_before: "standard", mode_after: "modified_ch7_11", rendered_for_open_cycle: false });
  assert.equal(pet.decision, "skip_this_cycle"); assert.equal(pet.skipped_cycle!.courtesy_period_end, "2026-09-16"); assert.equal(pet.resumes_with.statement_due_by, "2026-10-20");
});
test("14.3-T4: Given a written cease request from debtor's counsel received 2026-10-12 by e-mail (not the exclusive address), then `mode=exempt_cease_request` from 2026-10-12, the Nov-1 statement is held, and the evidence document is linked.", () => {
  const req = { received_on: D("2026-10-12"), from: "counsel" as const, channel: "email" as const, at_exclusive_address: false, document_id: "doc-counsel-cease-2026-10-12", statement_mailed_for_open_cycle: false, chapter: "13" as const };
  const c = ceaseRequest(req);
  assert.equal(c.honoured, true); assert.equal(c.refusal, null); assert.equal(c.mode_after, "exempt_cease_request"); assert.equal(c.effective_on, "2026-10-12"); assert.equal(c.timer, "REGZ_1026_41E5_CEASE_EFFECTIVE_0");
  assert.match(c.effective_basis!, /counsel — effective wherever received \(comment 41\(e\)\(5\)-1\)/);
  // the Nov-1 statement — the cycle open on 2026-10-12 (due 2026-10-01, statement due by 2026-10-20, showing the Nov-1 amount) — is held, not mailed
  assert.equal(c.held_statement!.amount_due_date, "2026-11-01"); assert.equal(c.held_statement!.cycle.due_date, "2026-10-01"); assert.equal(c.held_statement!.cycle.statement_due_by, "2026-10-20"); assert.equal(c.held_statement!.held, true); assert.match(c.held_statement!.reason, /effective on receipt .* held/);
  // the evidence document is linked and the status row carries it; received off the exclusive address → logged
  assert.deepEqual(c.evidence, { basis_document_id: "doc-counsel-cease-2026-10-12", kind: "written_request_image" }); assert.equal(c.logged_off_address, true);
  assert.deepEqual(c.status, { mode: "exempt_cease_request", basis_document_id: "doc-counsel-cease-2026-10-12", exclusive_address_used: false, last_request: { kind: "cease", from: "counsel", received_at: "2026-10-12" } });
  // the same letter through requests.classify: in writing, effective at 0.97 confidence, no human verification, counsel's e-mail is not "off address"
  const cls = classifyRequest({ channel: "email", kind: "cease", confidence: 0.97, from: "counsel", at_exclusive_address: false });
  assert.deepEqual([cls.in_writing, cls.effective, cls.human_verification, cls.logged_off_address], [true, true, false, false]);
  assert.equal(classifyRequest({ channel: "email", kind: "cease", confidence: 0.85, from: "counsel", at_exclusive_address: false }).human_verification, true);
  // already mailed → the exemption applies from the next cycle; no evidence → refused (guardrail); a phone call is never a cease request
  assert.equal(ceaseRequest({ ...req, statement_mailed_for_open_cycle: true }).held_statement!.held, false);
  const noDoc = ceaseRequest({ ...req, document_id: null }); assert.equal(noDoc.honoured, false); assert.match(noDoc.refusal!, /no exemption without a linked evidence document/); assert.equal(noDoc.status, null);
  assert.equal(statementModeGuard({ mode: "exempt_cease_request", basis_document_id: null, debtor_or_discharged: true, reaffirmed: false, rescission_window_lapsed: false }).allowed, false);
  assert.equal(statementModeGuard({ mode: "exempt_cease_request", basis_document_id: c.evidence!.basis_document_id, debtor_or_discharged: true, reaffirmed: false, rescission_window_lapsed: false }).allowed, true);
  const phone = ceaseRequest({ ...req, channel: "phone" }); assert.equal(phone.honoured, false); assert.match(phone.refusal!, /never inferred from a phone call/);
  // a refused request leaves the loan's mode unchanged — the chapter's variant (or the recorded mode), never a fixed Chapter 13 answer
  assert.equal(phone.mode_after, "modified_ch12_13"); assert.equal(ceaseRequest({ ...req, channel: "phone", chapter: "7" }).mode_after, "modified_ch7_11"); assert.equal(ceaseRequest({ ...req, document_id: null, chapter: "11", mode_before: "exempt_court_order" }).mode_after, "exempt_court_order");
  // from the debtor at the exclusive address the request is effective by rule; elsewhere it is honoured by policy and logged
  assert.match(ceaseRequest({ ...req, from: "debtor", at_exclusive_address: true }).effective_basis!, /exclusive address/);
  const off = ceaseRequest({ ...req, from: "debtor", channel: "mail" }); assert.equal(off.honoured, true); assert.match(off.effective_basis!, /honoured anyway \(policy\) and logged/); assert.equal(off.logged_off_address, true);
  // through the tools on the platform: the counsel e-mail classified at 0.97 emits `bankruptcy.statement_request.received{kind=cease, in_writing=true}` and arms REGZ_1026_41E5_CEASE_EFFECTIVE_0 on receipt;
  // recording `exempt_cease_request` with the linked image (a document on file — never a bare id) satisfies it the same day
  const r = rig("2026-10-12T14:00:00.000Z");
  r.rt.store.put("documents", "doc-counsel-cease-2026-10-12", { loan_id: LOAN, kind: "written_request_image" }, BK_OPS, r.clock.now());
  r.call("requests.classify", { loan_id: LOAN, channel: "email", kind: "cease", confidence: 0.97, from: "counsel", document_id: "doc-counsel-cease-2026-10-12", received_at: "2026-10-12T14:00:00.000Z" });
  const armed = r.timers.byCode("REGZ_1026_41E5_CEASE_EFFECTIVE_0")[0]!; assert.equal(armed.status, "armed"); assert.equal(armed.dueDate, "2026-10-12"); assert.equal(r.last("bankruptcy.statement_request.received").payload.in_writing, true);
  assert.throws(() => r.call("bk.statement_mode.set", { loan_id: LOAN, mode: "exempt_cease_request", basis_document_id: "doc-not-on-file", debtor_or_discharged: true }), /not a document on file/);
  assert.equal(r.call("bk.statement_mode.set", { loan_id: LOAN, mode: "exempt_cease_request", basis_document_id: "doc-counsel-cease-2026-10-12", debtor_or_discharged: true, effective_on: "2026-10-12" }).mode, "exempt_cease_request");
  assert.equal(armed.status, "satisfied"); assert.equal(r.last("bankruptcy.statement_mode.set").payload.mode, "exempt_cease_request");
});
test("14.3-T5: Given a later written request for statements from the non-filing co-borrower on 2027-03-03, then statements resume with the Apr-1 cycle (Mar cycle skippable) and the first statement may limit activity to the period since the last due date while exempt.", () => {
  const req = { received_on: D("2027-03-03"), from: "co_borrower" as const, in_writing: true, chapter: "13" as const, court_order_cease: false, rendered_for_open_cycle: false, exempt_since: D("2026-10-12") };
  const r = resumeRequest(req);
  assert.equal(r.honoured, true); assert.equal(r.refusal, null); assert.equal(r.mode_after, "modified_ch12_13"); assert.equal(r.exemption_ends_on, "2027-03-03"); assert.equal(r.timer, "REGZ_1026_41E5II_RESUME_NEXT_CYCLE");
  // Cycle naming: T5 names cycles by the due date that opens them (T1 names them by the amount-due date). The request lands in the cycle opened
  // 2027-03-01 (courtesy end 2027-03-16, statement due by 2027-03-20, showing the Apr-1 amount) before its courtesy end with nothing rendered, so
  // rule 1(d)/14.3-Q1 skips that statement ("Mar cycle skippable") and the first statement sent is the one due by 2027-04-20 ("resume with the Apr-1 cycle").
  assert.equal(r.transition!.decision, "skip_this_cycle"); assert.equal(r.transition!.skipped_cycle!.due_date, "2027-03-01"); assert.equal(r.transition!.skipped_cycle!.courtesy_period_end, "2027-03-16"); assert.equal(r.transition!.skipped_cycle!.statement_due_by, "2027-03-20");
  assert.equal(r.transition!.resumes_with.due_date, "2027-04-01"); assert.equal(r.transition!.resumes_with.statement_due_by, "2027-04-20"); assert.equal(r.transition!.resume_mode, "modified_ch12_13");
  // comment 41(f)(3)-3: the first statement may limit activity to the period since the last due date while exempt
  assert.equal(r.first_statement_activity_from, "2027-03-01");
  // writing required — a phone call is not a request; a court order to cease is not overridden by a request
  assert.equal(resumeRequest({ ...req, in_writing: false }).honoured, false); assert.match(resumeRequest({ ...req, in_writing: false }).refusal!, /in writing/);
  assert.equal(resumeRequest({ ...req, court_order_cease: true }).honoured, false); assert.equal(resumeRequest({ ...req, court_order_cease: true }).mode_after, "exempt_court_order");
  // through requests.classify on the platform: the written request emits the spec's `bankruptcy.statement_request.received{kind=resume}` with the cycle facts and
  // `bankruptcy.statement_resumption.scheduled{basis=written_request}`, which arms REGZ_1026_41E5II_RESUME_NEXT_CYCLE on the resumed statement's due-by (2027-04-20, not the receipt date); the H-30(F) statement's `notice.sent` satisfies it
  const p5 = rig("2027-03-03T15:00:00.000Z");
  p5.rt.store.put("bk_statement_status", `bkss-${LOAN}`, { loan_id: LOAN, mode: "exempt_cease_request", effective_on: "2026-10-12", debt_discharged: false }, BK_OPS, p5.clock.now());
  p5.rt.store.put("bankruptcy_cases", "case-13", { loan_id: LOAN, chapter: 13, status: "open", case_number_full: "4:26-bk-31234" }, BK_OPS, p5.clock.now());
  const out = p5.call("requests.classify", { loan_id: LOAN, channel: "mail", kind: "resume", confidence: 0.95, from: "co_borrower", at_exclusive_address: true, document_id: "doc-coborrower-resume-2027-03-03", received_at: "2027-03-03T15:00:00.000Z" });
  assert.equal((out.resumption as { resume_statement_due_by: string }).resume_statement_due_by, "2027-04-20"); assert.equal(out.status, "effective");
  const spec = p5.last("bankruptcy.statement_request.received"); assert.equal(spec.payload.kind, "resume"); assert.equal(spec.payload.in_writing, true); assert.equal(spec.payload.resume_statement_due_by, "2027-04-20"); assert.equal(spec.payload.skippable_statement_due_by, "2027-03-20"); assert.equal(spec.payload.first_statement_activity_from, "2027-03-01");
  const ev = p5.last(RESUMPTION_EVENT); assert.equal(ev.payload.basis, "written_request"); assert.equal(ev.payload.mode_after, "modified_ch12_13"); assert.equal(dueFromRegistry("REGZ_1026_41E5II_RESUME_NEXT_CYCLE", ev), "2027-04-20");
  const t = p5.timers.byCode("REGZ_1026_41E5II_RESUME_NEXT_CYCLE")[0]!; assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2027-04-20"); assert.equal(t.anchorDate, "2027-04-20");
  p5.clock.set("2027-04-17T12:00:00.000Z"); p5.emit("notice.sent", { notice_id: "ntc-stmt-1", template: "NTC_REGZ_41_STMT_BK12_13", sent_at: p5.clock.now() }); assert.equal(t.status, "satisfied");
  // the row's other spec trigger — a reaffirmation ending the exemption — is recorded through bk.statement_mode.set (`resume_basis=reaffirmation`) and arms the same row
  const r2 = rig("2027-03-03T15:00:00.000Z");
  r2.rt.store.put("bk_statement_status", `bkss-${LOAN}`, { loan_id: LOAN, mode: "exempt_cease_request", effective_on: "2026-10-12" }, BK_OPS, r2.clock.now());
  const set = r2.call("bk.statement_mode.set", { loan_id: LOAN, mode: "modified_ch7_11", resume_basis: "reaffirmation", effective_on: "2027-03-03", basis_event_id: "evt-reaffirmation-filed-2027-03-03", debtor_or_discharged: true });
  assert.equal((set.resumption as { basis: string }).basis, "reaffirmation"); assert.equal(r2.last(RESUMPTION_EVENT).payload.basis, "reaffirmation"); assert.equal(r2.timers.byCode("REGZ_1026_41E5II_RESUME_NEXT_CYCLE")[0]!.dueDate, "2027-04-20");
  // a request on a loan whose statements are not exempt resumes nothing: logged, no resumption event, nothing armed
  const r3 = rig("2027-03-03T15:00:00.000Z"); r3.rt.store.put("bk_statement_status", `bkss-${LOAN}`, { loan_id: LOAN, mode: "modified_ch12_13" }, BK_OPS, r3.clock.now());
  const logged = r3.call("requests.classify", { loan_id: LOAN, channel: "mail", kind: "resume", confidence: 0.95, from: "debtor", at_exclusive_address: true, received_at: "2027-03-03T15:00:00.000Z" });
  assert.equal(logged.resumption, null); assert.equal(r3.timers.byCode("REGZ_1026_41E5II_RESUME_NEXT_CYCLE").length, 0); assert.equal(r3.last("bankruptcy.statement_request.received").payload.ends_exemption, false);
});
test(`14.3-T6: Given a plan amended on 2027-02-10 from "surrender" to "retain and cure," then the exemption ends and the modified statement resumes after one skippable cycle.`, () => {
  const p = planTreatmentChanged({ amended_on: D("2027-02-10"), from: "surrender", to: "retain_and_cure", chapter: "13", rendered_for_open_cycle: false });
  assert.equal(p.exemption_ends, true); assert.equal(p.mode_after, "modified_ch12_13"); assert.match(p.basis, /41\(e\)\(5\)\(iv\)\(A\)-2/);
  assert.equal(p.transition.skippable, true); assert.equal(p.transition.decision, "skip_this_cycle"); assert.equal(p.transition.skipped_cycle!.due_date, "2027-02-01"); assert.equal(p.transition.skipped_cycle!.courtesy_period_end, "2027-02-16");
  assert.equal(p.transition.resumes_with.due_date, "2027-03-01"); assert.equal(p.transition.resumes_with.statement_due_by, "2027-03-20"); assert.equal(p.transition.resume_mode, "modified_ch12_13");
  // an amendment that keeps the treatment is not an (e)(5)(iv)(A) event; a surrender amendment starts (not ends) the exemption — recorded in the spec enum
  assert.equal(planTreatmentChanged({ amended_on: D("2027-02-10"), from: "retain_and_cure", to: "retain_and_cure", chapter: "13", rendered_for_open_cycle: false }).transition.skippable, false);
  const toSurrender = planTreatmentChanged({ amended_on: D("2027-02-10"), from: "retain_and_cure", to: "surrender", chapter: "13", rendered_for_open_cycle: false }); assert.equal(toSurrender.exemption_ends, false); assert.equal(toSurrender.mode_after, "exempt_plan_surrender");
  assert.ok((STATEMENT_MODES as readonly string[]).includes(toSurrender.mode_after));
  // on the platform: the amended plan reaches 14.3 as 14.1's `bankruptcy.status.changed` (spec inputs: "plan filed/amended/confirmed"), which arms this process's
  // SM_BK_STATEMENT_MODE_SYNC_1BD (bk_statement_status updated within 1 servicer business day: Wed 2027-02-10 → Thu 2027-02-11) and 7.1's REGZ_1026_41E5IV_BK_TRANSITION_1
  // (the (e)(5)(iv)(A)(3) event: one statement cycle from the next statement_due_by 2027-02-20 → 2027-03-20 — the same statement 14.3's own transition resumes with)
  const r = rig("2027-02-10T14:00:00.000Z", ["14.3", "7.1"]);
  r.rt.store.put("bk_statement_status", `bkss-${LOAN}`, { loan_id: LOAN, mode: "exempt_plan_surrender", basis_document_id: "doc-plan-2026-11-05", effective_on: "2026-11-05", debt_discharged: false }, BK_OPS, r.clock.now());
  r.rt.store.put("bankruptcy_cases", "case-13", { loan_id: LOAN, chapter: 13, status: "open", case_number_full: "4:26-bk-31234" }, BK_OPS, r.clock.now());
  r.rt.store.put("documents", "doc-plan-amended-2027-02-10", { loan_id: LOAN, kind: "amended_plan" }, BK_OPS, r.clock.now());
  const amended = r.emit("bankruptcy.status.changed", { loan_id: LOAN, to: "plan_amended", chapter: "13", plan_treatment: "retain_and_cure", plan_treatment_before: "surrender", document_id: "doc-plan-amended-2027-02-10", next_statement_due_by: "2027-02-20" });
  const sync = r.timers.byCode("SM_BK_STATEMENT_MODE_SYNC_1BD")[0]!; assert.equal(sync.status, "armed"); assert.equal(sync.dueDate, "2027-02-11"); assert.equal(dueFromRegistry("SM_BK_STATEMENT_MODE_SYNC_1BD", amended), "2027-02-11");
  const tr = r.timers.byCode("REGZ_1026_41E5IV_BK_TRANSITION_1")[0]!; assert.equal(tr.status, "armed"); assert.equal(tr.anchorDate, "2027-02-20"); assert.equal(tr.dueDate, "2027-03-20");
  // the amended plan is evidence for the mode it ends as much as for the one it starts: a plan document not on file is refused for the exemption side
  assert.throws(() => r.call("bk.statement_mode.set", { loan_id: LOAN, mode: "exempt_plan_surrender", basis_document_id: "doc-not-on-file" }), /not a document on file/);
  const set = r.call("bk.statement_mode.set", { loan_id: LOAN, case_id: "4:26-bk-31234", mode: "modified_ch12_13", resume_basis: "plan_amended_to_pay", effective_on: "2027-02-10", basis_document_id: "doc-plan-amended-2027-02-10", basis_event_id: amended.id, single_statement_used_for_cycle: "2027-03-01", resume_from_cycle: "2027-04-01" });
  assert.equal(set.mode, "modified_ch12_13"); assert.equal(set.basis_event_id, amended.id);
  const res = set.resumption as Record<string, unknown>; assert.equal(res.basis, "plan_amended_to_pay"); assert.equal(res.resume_statement_due_by, "2027-03-20"); assert.equal(res.skippable_statement_due_by, "2027-02-20");
  const ev = r.last(RESUMPTION_EVENT); assert.equal(ev.payload.basis, "plan_amended_to_pay"); assert.equal(ev.payload.mode_before, "exempt_plan_surrender"); assert.equal(ev.payload.mode_after, "modified_ch12_13"); assert.equal(ev.payload.decision, "skip_this_cycle");
  assert.equal(ev.payload.skipped_cycle_due_date, "2027-02-01"); assert.equal(ev.payload.resumes_with_due_date, "2027-03-01"); assert.equal(ev.payload.template, "NTC_REGZ_41_STMT_BK12_13"); assert.equal(ev.payload.basis_event_id, amended.id);
  assert.equal(ev.payload.resume_statement_due_by, tr.dueDate, "14.3's resumed statement is the one 7.1's transition row is due on");
  assert.equal(r.last("bankruptcy.statement_mode.set").payload.mode_before, "exempt_plan_surrender"); assert.equal(sync.status, "satisfied");
  // the spec's REGZ_1026_41E5II_RESUME_NEXT_CYCLE row is armed by a written request or a reaffirmation only — a plan amendment's deadline is the transition row above
  assert.equal(r.timers.byCode("REGZ_1026_41E5II_RESUME_NEXT_CYCLE").length, 0);
  r.clock.set("2027-03-18T15:00:00.000Z"); r.emit("statement.sent", { template: "NTC_REGZ_41_STMT_BK12_13", cycle_due_date: "2027-03-01", amount_due_date: "2027-04-01", single_statement_exemption_used: false, sent_at: r.clock.now() });
  assert.equal(tr.status, "satisfied");
});
test("14.3-T7: Given the fixture loan delinquent at the petition, then `REGX_1024_39C1_BK_WRITTEN_NOTICE_45` is due 2026-10-23, the notice contains no payment request, and a second notice is not sent in the same case even if delinquency recurs.", () => {
  const at = { petition_on: D("2026-09-08"), regx_days_delinquent_at_petition: 130, lossmit_available: true, fdcpa_cease_on_file: false, prior_notice_this_case: false, attorney_of_record: true };
  const e = earlyInterventionAtPetition(at);
  assert.equal(e.required, true); assert.equal(e.timer, "REGX_1024_39C1_BK_WRITTEN_NOTICE_45"); assert.equal(e.deadline, "2026-10-23"); assert.equal(e.payment_request, false); assert.equal(e.recipient, "counsel"); assert.equal(e.live_contact, "exempt_bk"); assert.equal(e.notice_code, BK_EI);
  assert.equal(earlyInterventionAtPetition({ ...at, attorney_of_record: false }).recipient, "borrower");
  assert.equal(earlyInterventionAtPetition({ ...at, fdcpa_cease_on_file: true }).required, false); assert.equal(earlyInterventionAtPetition({ ...at, regx_days_delinquent_at_petition: 0 }).timer, null);
  // the bk_early_intervention row: required / deadline / recipient, once_per_case_satisfied only when the notice id is linked
  const row = earlyInterventionRecord({ case_id: "4:26-bk-31234", loan_id: "BK-13-A", decision: e });
  assert.deepEqual([row.required, row.deadline, row.recipient, row.notice_id, row.once_per_case_satisfied], [true, "2026-10-23", "counsel", null, false]);
  assert.equal(earlyInterventionRecord({ case_id: "4:26-bk-31234", loan_id: "BK-13-A", decision: e, notice_id: "ntc-1", sent_at: "2026-10-20T15:00:00Z" }).once_per_case_satisfied, true);
  // the notice contains no payment request: the authored template passes its checklist; a payment request in the merged text is a block
  const { reg, v } = eiVersion(); const out = render(v.source, v.samplePayload);
  assert.doesNotMatch(out.text, /please pay|amount due|payment (is )?due|bring your loan current/i);
  assert.match(out.text, /not an attempt to collect a debt from you personally/); assert.match(out.text, /The owner of your mortgage loan is Fannie Mae/); assert.match(out.text, /Not all borrowers qualify/); assert.match(out.text, /HUD \(800\) 569-4287/); assert.match(out.text, /counsel of record/);
  assert.equal(evaluateChecklist(v, v.samplePayload, out).passed, true);
  const withRequest = { ...v.samplePayload, options: ["please pay $19,305.38 to bring your loan current"] };
  assert.ok(evaluateChecklist(v, withRequest, render(v.source, withRequest)).blocking.some((b) => b.rule_id === "REGX_39C1_NO_PAYMENT_REQUEST"));
  for (const field of ["amount_due_cents", "payment_due_date", "past_due_cents"]) { const merged = { ...v.samplePayload, [field]: field.endsWith("_cents") ? 2_200_460n : "2027-01-01" }; assert.ok(evaluateChecklist(v, merged, render(v.source, merged)).blocking.some((b) => b.rule_id === "no-amount-due-field"), field); }
  const late = { ...v.samplePayload, days_after_petition: 46 }; assert.ok(evaluateChecklist(v, late, render(v.source, late)).blocking.some((b) => b.rule_id === "timing-45"));
  assert.equal(reg.template(BK_EI).channelPolicy, "mail_only");
  // a second notice is not sent in the same case even if delinquency recurs (§1024.39(c)(1)(iii)(C))
  const again = laterDelinquencyDuringCase({ unpaid_due_date: D("2027-02-01"), once_per_case_satisfied: true, attorney_of_record: true });
  assert.equal(again.required, false); assert.equal(again.timer, null); assert.equal(again.deadline, null); assert.match(again.reason!, /once during a single bankruptcy case/);
  assert.equal(earlyInterventionAtPetition({ ...at, prior_notice_this_case: true }).required, false);
  const second = { ...v.samplePayload, prior_notice_this_case: true }; assert.ok(evaluateChecklist(v, second, render(v.source, second)).blocking.some((b) => b.rule_id === "once-per-case"));
  // had no notice gone out yet, a later delinquency starts the ordinary 45-day clock from the unpaid due date
  const first = laterDelinquencyDuringCase({ unpaid_due_date: D("2027-02-01"), once_per_case_satisfied: false, attorney_of_record: true }); assert.equal(first.timer, "REGX_1024_39B_BK_LATER_DELINQUENCY_45"); assert.equal(first.deadline, "2027-03-18");
  // through bk.statement_mode.set on the platform: the rule-6 decision is published as `bankruptcy.early_intervention.evaluated{trigger=petition, required=true, timer=…}` (14.1's
  // petition event carries none of the §1024.39(c) facts) and arms REGX_1024_39C1_BK_WRITTEN_NOTICE_45 on petition_date + 45 = 2026-10-23; the Registry's `notice.sent{template}` satisfies it
  const r = rig("2026-09-09T13:00:00.000Z");
  r.call("bk.statement_mode.set", { loan_id: LOAN, case_id: "4:26-bk-31234", mode: "single_statement_skip", debtor_or_discharged: true, single_statement_used_for_cycle: "2026-10-01", resume_from_cycle: "2026-11-01", addressing: "counsel", addressing_basis: "FDCPA debt collector with counsel of record (rule 4(iii))", early_intervention: { trigger: "petition", petition_on: "2026-09-08", regx_days_delinquent_at_petition: 130, lossmit_available: true, fdcpa_cease_on_file: false, prior_notice_this_case: false, attorney_of_record: true } });
  const ev = r.last(EI_EVENT); assert.equal(ev.payload.required, true); assert.equal(ev.payload.timer, "REGX_1024_39C1_BK_WRITTEN_NOTICE_45"); assert.equal(ev.payload.payment_request, false); assert.equal(ev.payload.recipient, "counsel"); assert.equal(ev.payload.petition_date, "2026-09-08");
  assert.equal(dueFromRegistry("REGX_1024_39C1_BK_WRITTEN_NOTICE_45", ev), "2026-10-23");
  const t45 = r.timers.byCode("REGX_1024_39C1_BK_WRITTEN_NOTICE_45")[0]!; assert.equal(t45.status, "armed"); assert.equal(t45.dueDate, "2026-10-23"); assert.equal(t45.anchorDate, "2026-09-08");
  assert.equal(r.rt.store.get("bk_early_intervention", "4:26-bk-31234")!.data.deadline, "2026-10-23"); assert.equal(r.last("bankruptcy.addressing.decided").payload.basis_present, true);
  r.clock.set("2026-10-20T15:00:00.000Z"); r.emit("notice.sent", { notice_id: "ntc-ei-bk-1", template: BK_EI, sent_at: r.clock.now() }); assert.equal(t45.status, "satisfied");
  // a later delinquency in the same case with no notice yet arms REGX_1024_39B_BK_LATER_DELINQUENCY_45 on the unpaid due date + 45 (the 45th day of delinquency); once the case's notice went out the decision is required=false and nothing arms
  const r2 = rig("2027-02-17T13:00:00.000Z");
  r2.call("bk.statement_mode.set", { loan_id: LOAN, case_id: "4:26-bk-31234", mode: "modified_ch12_13", debtor_or_discharged: true, early_intervention: { trigger: "later_delinquency", unpaid_due_date: "2027-02-01", once_per_case_satisfied: false, attorney_of_record: true } });
  const later = r2.timers.byCode("REGX_1024_39B_BK_LATER_DELINQUENCY_45")[0]!; assert.equal(later.dueDate, "2027-03-18"); assert.equal(dueFromRegistry("REGX_1024_39B_BK_LATER_DELINQUENCY_45", r2.last(EI_EVENT)), "2027-03-18");
  r2.call("bk.statement_mode.set", { loan_id: LOAN, case_id: "4:26-bk-31234", mode: "modified_ch12_13", debtor_or_discharged: true, early_intervention: { trigger: "later_delinquency", unpaid_due_date: "2027-05-01", once_per_case_satisfied: true, attorney_of_record: true } });
  assert.equal(r2.last(EI_EVENT).payload.required, false); assert.equal(r2.timers.byCode("REGX_1024_39B_BK_LATER_DELINQUENCY_45").length, 1);
  // an FDCPA §805(c) cease on file → required=false: no timer, no false sev-1
  const r3 = rig("2026-09-09T13:00:00.000Z");
  r3.call("bk.statement_mode.set", { loan_id: LOAN, mode: "modified_ch12_13", debtor_or_discharged: true, early_intervention: { trigger: "petition", petition_on: "2026-09-08", regx_days_delinquent_at_petition: 130, fdcpa_cease_on_file: true, attorney_of_record: true } });
  assert.equal(r3.last(EI_EVENT).payload.required, false); assert.equal(r3.timers.byCode("REGX_1024_39C1_BK_WRITTEN_NOTICE_45").length, 0);
  // the (b)(2)(ii) contact items, the (b)(2)(iv) application location and the legend are checked as merged: an empty team number, address, upload location or case number fails the checklist
  for (const [field, rule] of [["team_phone", "ii-contact"], ["servicer_address", "ii-contact"], ["exclusive_address", "ii-contact"], ["upload_url", "iv-apply"], ["case_number", "bk-legend"]] as const) { const p: Record<string, unknown> = { ...v.samplePayload }; delete p[field]; const res = evaluateChecklist(v, p, render(v.source, p)); assert.equal(res.passed, false, field); assert.ok(res.blocking.some((b) => b.rule_id === rule), `${field} → ${rule}`); }
});
test("14.3-T8: Given an FDCPA-covered loan with a debtor's attorney of record and no consent, then the statement is addressed to counsel and no debtor copy is mailed; given counsel's consent, both.", () => {
  const noConsent = addressingDecision({ fdcpa_debt_collector: true, attorney_of_record: true, counsel_consents_debtor_copy: false });
  assert.equal(noConsent.addressing, "counsel"); assert.deepEqual(noConsent.recipients, ["counsel"]); assert.equal(noConsent.debtor_copy_mailed, false); assert.equal(noConsent.precedence, "iii"); assert.match(noConsent.addressing_basis, /Reg F §1006\.6\(b\)\(2\); 14\.3-Q2 default/);
  const consent = addressingDecision({ fdcpa_debt_collector: true, attorney_of_record: true, counsel_consents_debtor_copy: true });
  assert.equal(consent.addressing, "counsel_and_debtor"); assert.deepEqual(consent.recipients, ["counsel", "debtor"]); assert.equal(consent.debtor_copy_mailed, true); assert.equal(consent.precedence, "iii");
  // rule 4 precedence: (i) an order or local rule first (and to attorney), (ii) counsel's instruction, (iii) Reg F, (iv) otherwise the debtor of record with a counsel courtesy copy only on request
  const local = addressingDecision({ local_rule_bars_debtor_contact: true, fdcpa_debt_collector: false, attorney_of_record: true, counsel_consents_debtor_copy: true }); assert.equal(local.addressing, "counsel"); assert.equal(local.precedence, "i"); assert.equal(local.escalate, "attorney"); assert.equal(local.debtor_copy_mailed, false);
  assert.equal(addressingDecision({ court_directs: "debtor", fdcpa_debt_collector: true, attorney_of_record: true, counsel_consents_debtor_copy: false }).addressing, "debtor");
  assert.equal(addressingDecision({ counsel_instruction: "send_to_debtor", fdcpa_debt_collector: true, attorney_of_record: true, counsel_consents_debtor_copy: false }).addressing, "debtor");
  assert.equal(addressingDecision({ counsel_instruction: "send_to_counsel", fdcpa_debt_collector: false, attorney_of_record: true, counsel_consents_debtor_copy: false }).precedence, "ii");
  const cease = addressingDecision({ counsel_instruction: "cease", fdcpa_debt_collector: true, attorney_of_record: true, counsel_consents_debtor_copy: false }); assert.equal(cease.exemption, "exempt_cease_request"); assert.deepEqual(cease.recipients, []);
  const plain = addressingDecision({ fdcpa_debt_collector: false, attorney_of_record: true, counsel_consents_debtor_copy: false }); assert.equal(plain.addressing, "debtor"); assert.deepEqual(plain.recipients, ["debtor"]); assert.equal(plain.precedence, "iv");
  assert.equal(addressingDecision({ fdcpa_debt_collector: false, attorney_of_record: true, counsel_consents_debtor_copy: false, counsel_requests_courtesy_copy: true }).addressing, "counsel_and_debtor");
  // the counsel-routed early-intervention notice says which: no debtor copy without consent; with consent the copy is named and the consent document must be on file
  const { v } = eiVersion();
  const routed = { ...v.samplePayload, recipient: "counsel", counsel_routed: true, debtor_copy: false };
  const out = render(v.source, routed); assert.match(out.text, /No copy is sent to the borrower directly \(12 CFR 1006\.6\(b\)\(2\)\)/); assert.doesNotMatch(out.text, /copy is sent to the borrower with counsel's consent/); assert.equal(evaluateChecklist(v, routed, out).passed, true);
  const withCopy = { ...routed, debtor_copy: true, counsel_consent_document_id: "doc-counsel-consent-2026-10-15" }; const out2 = render(v.source, withCopy);
  assert.match(out2.text, /A copy is sent to the borrower with counsel's consent/); assert.doesNotMatch(out2.text, /No copy is sent/); assert.equal(evaluateChecklist(v, withCopy, out2).passed, true);
  const noConsentDoc = { ...routed, debtor_copy: true }; assert.ok(evaluateChecklist(v, noConsentDoc, render(v.source, noConsentDoc)).blocking.some((b) => b.rule_id === "debtor-copy-consent"));
});
test("14.3-T9: Given dismissal on 2027-06-05 (next due date 2027-07-01), then live contact and written-notice clocks re-arm from 2027-07-01 and the statement variant returns to `standard` after one skippable cycle.", () => {
  const d = dismissal({ dismissed_on: D("2027-06-05"), discharge_entered: false, chapter: "13", rendered_for_open_cycle: false });
  assert.equal(d.mode_after, "standard");
  const ei = d.early_intervention!; assert.equal(ei.gate, "REGX_1024_39C2_RESUME_GATE"); assert.equal(ei.resume_from_due_date, "2027-07-01"); assert.equal(ei.live_contact, "re_armed"); assert.equal(ei.written_notice, "re_armed");
  assert.equal(ei.live_contact_due, "2027-08-06"); assert.equal(ei.written_notice_due, "2027-08-15");   // day 36 / day 45 from the July 1 due date (11.1/11.2)
  // the statement variant returns to `standard` after one skippable cycle: Jun-1 cycle skipped, Jul-1 cycle standard
  assert.equal(d.transition.decision, "skip_this_cycle"); assert.equal(d.transition.skipped_cycle!.due_date, "2027-06-01"); assert.equal(d.transition.resumes_with.due_date, "2027-07-01"); assert.equal(d.transition.resumes_with.statement_due_by, "2027-07-20"); assert.equal(d.transition.resume_mode, "standard");
  // the gate evaluator behind REGX_1024_39C2_RESUME_GATE opens after the due date ("after the next payment due date that follows", §1024.39(c)(2)(i) — the line the communications matrix draws, T12), and never for a discharged loan
  const gate = EVALUATORS_14_3["14.3.earlyInterventionResumeGate"]!;
  assert.equal(gate({ today: "2027-06-20", resume_from_due_date: "2027-07-01", status: "dismissed" }).open, false); assert.equal(gate({ today: "2027-07-01", resume_from_due_date: "2027-07-01" }).open, false); assert.equal(gate({ today: "2027-07-02", resume_from_due_date: "2027-07-01" }).open, true);
  assert.equal(gate({ today: "2027-07-02", resume_from_due_date: "2027-07-01", debt_discharged: true, reaffirmed: false }).open, false);
  // a dismissal after discharge leaves the loan under (f)
  const post = dismissal({ dismissed_on: D("2027-06-05"), discharge_entered: true, chapter: "7", rendered_for_open_cycle: false }); assert.equal(post.mode_after, "modified_ch7_11"); assert.equal(post.early_intervention, null);
  // through bk.statement_mode.set on the platform: `standard` is judged on the case state — refused while the case is open whatever the caller asserts
  const r = rig("2027-06-05T16:00:00.000Z");
  r.rt.store.put("bk_statement_status", `bkss-${LOAN}`, { loan_id: LOAN, mode: "modified_ch12_13", effective_on: "2026-09-08" }, BK_OPS, r.clock.now());
  r.rt.store.put("bankruptcy_cases", "case-13", { loan_id: LOAN, chapter: 13, status: "open", case_number_full: "4:26-bk-31234" }, BK_OPS, r.clock.now());
  assert.throws(() => r.call("bk.statement_mode.set", { loan_id: LOAN, mode: "standard" }), /no `standard` variant while any consumer is a debtor or discharged[^]*open case/);
  assert.throws(() => r.call("bk.statement_mode.set", { loan_id: LOAN, mode: "standard", debtor_or_discharged: false, reaffirmed: true, rescission_window_lapsed: true }), /open case/);
  // the dismissal (without discharge) is recorded by 14.1; the resume decision is published with the gate's facts, arms REGX_1024_39C2_RESUME_GATE (evaluator-backed) and 11.1's counter job re-opening the July-1 window satisfies it
  r.rt.store.put("bankruptcy_cases", "case-13", { status: "dismissed", dismissal_at: "2027-06-05" }, BK_OPS, r.clock.now());
  assert.throws(() => r.call("bk.statement_mode.set", { loan_id: LOAN, mode: "standard" }), /basis_event_id/);
  r.call("bk.statement_mode.set", { loan_id: LOAN, mode: "single_statement_skip", basis_event_id: "evt-dismissal-2027-06-05", single_statement_used_for_cycle: "2027-07-01", resume_from_cycle: "2027-08-01", early_intervention: { trigger: "resume", event_on: "2027-06-05", status: "dismissed", debt_discharged: false, reaffirmed: false } });
  const ev = r.last(EI_EVENT); assert.equal(ev.payload.timer, "REGX_1024_39C2_RESUME_GATE"); assert.equal(ev.payload.required, true); assert.equal(ev.payload.resume_from_due_date, "2027-07-01"); assert.equal(ev.payload.live_contact_due, "2027-08-06"); assert.equal(ev.payload.written_notice_due, "2027-08-15");
  const g = r.timers.byCode("REGX_1024_39C2_RESUME_GATE")[0]!; assert.equal(g.status, "armed"); assert.equal(g.anchorDate, "2027-07-01"); assert.equal(g.note, "evaluator:14.3.earlyInterventionResumeGate");
  assert.equal(gate({ ...ev.payload, today: "2027-06-20" }).open, false); assert.equal(gate({ ...ev.payload, today: "2027-07-01" }).open, false); assert.equal(gate({ ...ev.payload, today: "2027-07-02" }).open, true);
  r.clock.set("2027-07-02T05:05:00.000Z"); const run = counterRun(D("2027-07-01"), D("2027-07-02")); for (const e of run.events) r.emit(e.type, e.payload);
  assert.equal(g.status, "satisfied"); assert.equal(run.window.live_due_at, "2027-08-06"); assert.equal(run.window.notice_due_at, "2027-08-15");
  // then `standard` after the skippable cycle — the dismissal event is the basis
  assert.equal(r.call("bk.statement_mode.set", { loan_id: LOAN, mode: "standard", basis_event_id: "evt-dismissal-2027-06-05", effective_on: "2027-07-01" }).mode, "standard");
  // a discharge without reaffirmation never re-opens live contact: required=false, the gate is not armed (§1024.39(c)(2)(ii))
  const r2 = rig("2027-06-05T16:00:00.000Z");
  r2.call("bk.statement_mode.set", { loan_id: LOAN, mode: "modified_ch7_11", debt_discharged: true, early_intervention: { trigger: "resume", event_on: "2027-06-05", status: "closed", debt_discharged: true, reaffirmed: false } });
  assert.equal(r2.last(EI_EVENT).payload.required, false); assert.equal(r2.timers.byCode("REGX_1024_39C2_RESUME_GATE").length, 0);
});
test("14.3-T10: Given a discharged (no reaffirmation) loan that receives a $500 payment on 2027-02-03 while delinquent, then the written early-intervention notice (no payment request) is scheduled under `REGX_1024_39C2_DISCHARGE_WRITTEN_NOTICE` and live contact remains off.", () => {
  const p = postDischargePayment({ discharge_on: D("2026-12-15"), reaffirmed: false, payment_received_on: D("2027-02-03"), payment_cents: 50_000n, delinquent: true });
  assert.equal(p.applies, true); assert.equal(p.timer, "REGX_1024_39C2_DISCHARGE_WRITTEN_NOTICE"); assert.equal(p.notice_code, BK_EI); assert.equal(p.payment_request, false);
  assert.equal(p.next_due_date, "2027-03-01"); assert.equal(p.written_notice_due, "2027-04-15");   // 45 days of delinquency measured from the next due date (11.2)
  assert.equal(p.live_contact, "exempt_discharge"); assert.equal(p.live_contact_due, null);
  assert.equal(postDischargePayment({ discharge_on: D("2026-12-15"), reaffirmed: true, payment_received_on: D("2027-02-03"), payment_cents: 50_000n, delinquent: true }).applies, false);
  assert.equal(postDischargePayment({ discharge_on: D("2026-12-15"), reaffirmed: false, payment_received_on: D("2027-02-03"), payment_cents: 50_000n, delinquent: false }).timer, null);
  // the post-discharge variant of the notice: discharge legend, tied to the payment, still no payment request
  const { v } = eiVersion(); const payload = { ...v.samplePayload, trigger: "discharge_payment", discharged: true, chapter: "7", recipient: "borrower", counsel_routed: false, days_after_petition: 148, payment_received_on: "2027-02-03", notice_date: "2027-04-13" };
  const out = render(v.source, payload); assert.equal(evaluateChecklist(v, payload, out).passed, true); assert.match(out.text, /You received a discharge of your personal liability/); assert.doesNotMatch(out.text, /please pay|amount due/i);
  const untied = { ...payload, payment_received_on: undefined }; assert.ok(evaluateChecklist(v, untied, render(v.source, untied)).blocking.some((b) => b.rule_id === "discharge-trigger"));
  // through bk.statement_mode.set on the platform: cashiering's `payment.received` carries `delinquent` but no discharge facts, so the rule-6 decision is published as
  // `bankruptcy.early_intervention.evaluated{trigger=discharge_payment, required=true, timer=…}` and arms REGX_1024_39C2_DISCHARGE_WRITTEN_NOTICE on next_due_date 2027-03-01 + 45 = 2027-04-15 — not the payment date
  const r = rig("2027-02-03T15:00:00.000Z");
  r.call("bk.statement_mode.set", { loan_id: LOAN, case_id: "4:26-bk-31240", mode: "modified_ch7_11", debt_discharged: true, early_intervention: { trigger: "discharge_payment", discharge_on: "2026-12-15", reaffirmed: false, payment_received_on: "2027-02-03", payment_cents: "50000", delinquent: true, attorney_of_record: false } });
  const ev = r.last(EI_EVENT); assert.equal(ev.payload.required, true); assert.equal(ev.payload.timer, "REGX_1024_39C2_DISCHARGE_WRITTEN_NOTICE"); assert.equal(ev.payload.next_due_date, "2027-03-01"); assert.equal(ev.payload.payment_request, false); assert.equal(ev.payload.live_contact, "exempt_discharge"); assert.equal(ev.payload.live_contact_due, null);
  assert.equal(dueFromRegistry("REGX_1024_39C2_DISCHARGE_WRITTEN_NOTICE", ev), "2027-04-15");
  const t = r.timers.byCode("REGX_1024_39C2_DISCHARGE_WRITTEN_NOTICE")[0]!; assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2027-04-15"); assert.equal(t.anchorDate, "2027-03-01");
  assert.equal(r.rt.store.get("bk_early_intervention", "4:26-bk-31240")!.data.deadline, "2027-04-15");
  r.clock.set("2027-04-13T15:00:00.000Z"); r.emit("notice.sent", { notice_id: "ntc-ei-bk-2", template: BK_EI, sent_at: r.clock.now() }); assert.equal(t.status, "satisfied");
  // reaffirmed → the discharge rule does not apply (required=false, nothing armed)
  const r2 = rig("2027-02-03T15:00:00.000Z");
  r2.call("bk.statement_mode.set", { loan_id: LOAN, mode: "modified_ch7_11", debtor_or_discharged: true, early_intervention: { trigger: "discharge_payment", discharge_on: "2026-12-15", reaffirmed: true, payment_received_on: "2027-02-03", payment_cents: "50000", delinquent: true, attorney_of_record: false } });
  assert.equal(r2.last(EI_EVENT).payload.required, false); assert.equal(r2.timers.byCode("REGX_1024_39C2_DISCHARGE_WRITTEN_NOTICE").length, 0);
});
test("14.3-T11: Given a reaffirmation filed 2026-11-20 with discharge 2026-12-15, then the variant stays modified until 2027-01-19 (60 days after filing, later than discharge) and switches to `standard` thereafter.", () => {
  // §524(c)(4): rescission runs to the later of the discharge and 60 days after filing → 2027-01-19 (later than the 2026-12-15 discharge)
  assert.equal(reaffirmationRescissionEnds(D("2026-11-20"), D("2026-12-15")), "2027-01-19");
  const on = reaffirmationVariant({ filed_on: D("2026-11-20"), discharge_on: D("2026-12-15"), chapter: "7", as_of: D("2027-01-19") });
  assert.equal(on.rescission_window_ends, "2027-01-19"); assert.equal(on.reaffirmation_final, false); assert.equal(on.mode, "modified_ch7_11");
  assert.equal(reaffirmationVariant({ filed_on: D("2026-11-20"), discharge_on: D("2026-12-15"), chapter: "7", as_of: D("2026-12-16") }).mode, "modified_ch7_11");
  const after = reaffirmationVariant({ filed_on: D("2026-11-20"), discharge_on: D("2026-12-15"), chapter: "7", as_of: D("2027-01-20") });
  assert.equal(after.reaffirmation_final, true); assert.equal(after.mode, "standard"); assert.match(after.basis, /41\(f\)-6/);
  // a rescission inside the window keeps the loan modified; a discharge later than filing + 60 controls
  assert.equal(reaffirmationVariant({ filed_on: D("2026-11-20"), discharge_on: D("2026-12-15"), chapter: "7", as_of: D("2027-02-01"), rescinded_on: D("2027-01-10") }).mode, "modified_ch7_11");
  assert.equal(reaffirmationRescissionEnds(D("2026-11-20"), D("2027-02-01")), "2027-02-01");
  // the discharge itself changes nothing on a reaffirmed loan (comment 41(f)-1): the transition keeps `modified_ch7_11`, no cycle is skipped, and `standard_from` is the window's end — a reaffirmation needs its filing date
  const t = dischargeTransition({ petition_on: D("2026-09-08"), discharge_on: D("2026-12-15"), reaffirmed: true, reaffirmation_filed_on: D("2026-11-20"), chapter: "7", rendered_for_open_cycle: false });
  assert.equal(t.resume_mode, "modified_ch7_11"); assert.equal(t.decision, "none"); assert.equal(t.skippable, false); assert.equal(t.standard_from, "2027-01-19"); assert.match(t.basis, /524\(c\)\(4\) rescission window lapses 2027-01-19/);
  assert.throws(() => dischargeTransition({ petition_on: D("2026-09-08"), discharge_on: D("2026-12-15"), reaffirmed: true, chapter: "7", rendered_for_open_cycle: false }), /reaffirmation_filed_on/);
  assert.equal(dischargeTransition({ petition_on: D("2026-09-08"), discharge_on: D("2026-12-15"), reaffirmed: false, chapter: "7", rendered_for_open_cycle: false }).standard_from, null);
  // bk.statement_mode.set judges `standard` on the case record: the reaffirmation (filed 2026-11-20) and discharge (2026-12-15) keep the loan modified through 2027-01-19; from 2027-01-20 `standard` is allowed
  const r = rig("2027-01-19T15:00:00.000Z");
  r.rt.store.put("bk_statement_status", `bkss-${LOAN}`, { loan_id: LOAN, mode: "modified_ch7_11" }, BK_OPS, r.clock.now());
  r.rt.store.put("bankruptcy_cases", "case-7", { loan_id: LOAN, chapter: 7, status: "closed", discharge_at: "2026-12-15", reaffirmation: { filed_on: "2026-11-20", status: "approved" } }, BK_OPS, r.clock.now());
  assert.throws(() => r.call("bk.statement_mode.set", { loan_id: LOAN, mode: "standard", effective_on: "2027-01-19" }), /debtor or discharged[^]*reaffirmation inside the §524\(c\)\(4\) window/);
  assert.equal(r.call("bk.statement_mode.set", { loan_id: LOAN, mode: "standard", effective_on: "2027-01-20", basis_event_id: "evt-reaffirmation-final-2027-01-20" }).mode, "standard");
});
test("14.3-T12: Given a D2-2-03 reminder trigger on a loan with `stay_in_effect`, then no reminder is sent and the suppression is recorded with the matrix citation.", () => {
  const s = suppressCommunication({ communication_code: "D2_2_03_PAYMENT_REMINDER", mode: "stay_in_effect", triggered_on: D("2026-10-17"), loan_id: "BK-13-A" });
  assert.equal(s.sent, false); assert.equal(s.row.action, "suppress"); assert.equal(s.row.legend_required, false); assert.equal(s.row.classified, true);
  assert.deepEqual(s.suppression, { loan_id: "BK-13-A", communication_code: "D2_2_03_PAYMENT_REMINDER", mode: "stay_in_effect", action: "suppress", citation: s.row.citation, matrix_version: COMMUNICATIONS_MATRIX_VERSION, recorded_on: "2026-10-17" });
  assert.match(s.suppression!.citation, /D2-2-03/); assert.match(s.suppression!.citation, /362\(a\)\(6\)/); assert.match(s.suppression!.citation, /E-2\.1-03/);
  // the matrix is a versioned rule table (version × code × mode, the communications_matrix PK) and every row cites its authority
  const rows = communicationsMatrixRows(); assert.equal(rows.length, 25 * 5); assert.equal(new Set(rows.map((r) => `${r.version}|${r.communication_code}|${r.mode}`)).size, rows.length); assert.ok(rows.every((r) => r.version === COMMUNICATIONS_MATRIX_VERSION && r.citation.length > 0));
  // the rest of the matrix: informational statements go (modified), collection stays suppressed after discharge, everything resumes after dismissal
  assert.equal(communicationsMatrix("PERIODIC_STATEMENT", "stay_in_effect").action, "send_modified"); assert.equal(communicationsMatrix("PERIODIC_STATEMENT", "stay_in_effect").legend_required, true);
  assert.equal(communicationsMatrix("NOE_RFI_RESPONSE", "stay_in_effect").action, "send_via_counsel"); assert.equal(communicationsMatrix("EARLY_INTERVENTION_BK", "stay_in_effect").action, "send");
  assert.equal(communicationsMatrix("D2_2_03_PAYMENT_REMINDER", "discharged_no_reaffirm").action, "suppress"); assert.equal(communicationsMatrix("BREACH_LETTER_IN_REM", "discharged_no_reaffirm").action, "send_modified");
  assert.equal(communicationsMatrix("FORECLOSURE_NOTICE", "stay_relief_granted").action, "send"); assert.equal(communicationsMatrix("D2_2_03_PAYMENT_REMINDER", "stay_relief_granted").action, "suppress");
  assert.equal(communicationsMatrix("D2_2_03_PAYMENT_REMINDER", "dismissed").action, "send"); assert.equal(suppressCommunication({ communication_code: "D2_2_03_PAYMENT_REMINDER", mode: "dismissed", triggered_on: D("2027-07-05"), loan_id: "BK-13-A" }).sent, true);
  assert.equal(communicationsMatrix("COLLECTION_CALL", "codebtor_protected").action, "suppress"); assert.equal(communicationsMatrix("PERIODIC_STATEMENT", "codebtor_protected").action, "send_modified");
  // fails closed: a communication the matrix has not classified is suppressed while any bankruptcy mode applies (E-2.1-03 "any and all debt collection efforts")
  const unknown = suppressCommunication({ communication_code: "NEW_COLLECTION_LETTER", mode: "stay_in_effect", triggered_on: D("2026-10-17"), loan_id: "BK-13-A" });
  assert.equal(unknown.sent, false); assert.equal(unknown.row.classified, false); assert.match(unknown.suppression!.citation, /unclassified communication code/);
  assert.equal(communicationsMatrix("NEW_COLLECTION_LETTER", "discharged_no_reaffirm").action, "suppress"); assert.equal(communicationsMatrix("NEW_COLLECTION_LETTER", "codebtor_protected").action, "suppress");
  // `dismissed` resumes collection communications only after the next payment due date that follows the dismissal (§1024.39(c)(2)(i); T9: dismissed 2027-06-05 → 2027-07-01)
  const early = suppressCommunication({ communication_code: "D2_2_03_PAYMENT_REMINDER", mode: "dismissed", triggered_on: D("2027-06-10"), loan_id: "BK-13-A", resume_from_due_date: D("2027-07-01") });
  assert.equal(early.sent, false); assert.match(early.suppression!.citation, /1024\.39\(c\)\(2\)\(i\)/); assert.match(early.suppression!.citation, /2027-07-01/);
  assert.equal(suppressCommunication({ communication_code: "D2_2_03_PAYMENT_REMINDER", mode: "dismissed", triggered_on: D("2027-07-01"), loan_id: "BK-13-A", resume_from_due_date: D("2027-07-01") }).sent, false);
  assert.equal(suppressCommunication({ communication_code: "D2_2_03_PAYMENT_REMINDER", mode: "dismissed", triggered_on: D("2027-07-02"), loan_id: "BK-13-A", resume_from_due_date: D("2027-07-01") }).sent, true);
  // the same line the REGX_1024_39C2_RESUME_GATE evaluator draws (T9): exempt through the due date, resumed the day after
  const gate = EVALUATORS_14_3["14.3.earlyInterventionResumeGate"]!; assert.equal(gate({ today: "2027-07-01", resume_from_due_date: "2027-07-01", status: "dismissed" }).open, false); assert.equal(gate({ today: "2027-07-02", resume_from_due_date: "2027-07-01", status: "dismissed" }).open, true);
  assert.equal(communicationsMatrix("PERIODIC_STATEMENT", "dismissed", { triggered_on: D("2027-06-10"), resume_from_due_date: D("2027-07-01") }).action, "send");
});

test("14.3 worked figures: example B Feb-1-2027 statement — installment $2,806.72 = $2,054.22 P&I + $752.50 escrow; amount due $8,420.16 = 2,806.72 + past-due post-petition $5,613.44; split #43 principal $368.63 / interest $1,685.59; fees since last statement $0.00; $1,500.00 in suspense, $1,306.72 more to apply; arrearage $14,241.94 from the POC; example C Jan-1-2027 — 7 × $2,699.22 = $18,894.54 + $410.84 late charges = $19,305.38 to bring current; amount due $22,004.60", () => {
  // scheduled split for payment #43 of the $325,000.00 / 6.500% / 360 note (14.1 rule 6: plan-terms view): the P&I is the note's level payment computed from the terms — $2,054.22 (205_422 cents) — never a typed-in figure; = principal $368.63 + interest $1,685.59 on the $311,185.63 balance before #43
  const pi = levelPayment(32_500_000n, ratePercent("6.500"), 360); assert.equal(pi, 205_422n); assert.equal(formatCents(pi), "$2,054.22");
  const split = postpetitionSplit({ original_upb_cents: 32_500_000n, rate_pct: "6.500", term_months: 360, payment_number: 43, escrow_cents: 75_250n });
  assert.equal(split.pi_cents, pi); assert.equal(split.upb_before_cents, 31_118_563n); assert.equal(split.pi_cents, postpetitionSplit({ original_upb_cents: 32_500_000n, rate_pct: "6.500", term_months: 360, payment_number: 43, pi_cents: 205_422n, escrow_cents: 75_250n }).pi_cents);
  assert.equal(split.interest_cents, 168_559n); assert.equal(formatCents(split.interest_cents), "$1,685.59"); assert.equal(split.principal_cents, 36_863n); assert.equal(formatCents(split.principal_cents), "$368.63");
  assert.equal(split.principal_cents + split.interest_cents, 205_422n); assert.equal(formatCents(split.principal_cents + split.interest_cents), "$2,054.22"); assert.equal(split.installment_cents, 280_672n);
  // the pre-petition arrearage is 14.1's proof-of-claim figure (fixture BK-13-A), not a typed-in constant
  const upb33 = balanceAfter(cents("325000"), "6.500", 360, 33);
  const unpaidPre = C.unpaidSplits(upb33, "6.500", cents("2054.22"), D("2026-05-01"), D("2026-09-08"), cents("102.71"), 15);
  const poc = C.proofOfClaim({ ib_upb_cents: upb33, nib_cents: 0n, unpaid: unpaidPre, other_prepetition_fees_cents: cents("40"), escrow_balance_at_petition_cents: -cents("3920"), funds_on_hand_cents: cents("400"), pi_cents: cents("2054.22"), escrow_monthly_cents: cents("645") });
  assert.equal(poc.part3.total_prepetition_arrearage_cents, 1_424_194n);
  // Feb 1, 2027 statement (cut-off 2027-01-17): Dec 1 and Jan 1 unpaid, $1,500.00 received 01-15 into post-petition suspense
  const s = exampleB({ installment: split, prepetition: { received_since_last_cents: 0n, received_since_filing_cents: 0n, arrearage_cents: poc.part3.total_prepetition_arrearage_cents, bar_date_passed: true } });
  assert.equal(s.installment_cents, 280_672n); assert.equal(formatCents(s.installment_cents), "$2,806.72"); assert.equal(s.explanation.escrow_cents, 75_250n); assert.equal(s.explanation.escrow_display, "$752.50");
  assert.equal(s.explanation.principal_cents, split.principal_cents); assert.equal(s.explanation.interest_cents, split.interest_cents); assert.equal(s.explanation.fees_since_last_cents, 0n); assert.equal(s.explanation.fees_since_last_display, "$0.00");
  assert.equal(s.amount_due_cents, 842_016n); assert.equal(s.amount_due_display, "$8,420.16"); assert.equal(s.past_due_postpetition_cents, 561_344n); assert.equal(s.past_due_postpetition_display, "$5,613.44"); assert.equal(s.amount_due_cents, s.installment_cents + s.past_due_postpetition_cents);
  assert.equal(s.past_payments.since_last_statement_cents, 150_000n); assert.equal(s.past_payments.since_last_statement_display, "$1,500.00"); assert.equal(s.past_payments.unapplied_held_display, "$1,500.00"); assert.equal(s.past_payments.ytd_cents, 150_000n);
  assert.equal(s.shortfall_cents, 130_672n); assert.equal(s.shortfall_cents, s.installment_cents - s.past_payments.unapplied_held_cents); assert.equal(s.d5_partial_payment_text, "We need $1,306.72 more to apply a full post-petition payment.");
  assert.equal(s.prepetition_arrearage.balance_cents, 1_424_194n); assert.equal(s.prepetition_arrearage.display, "$14,241.94"); assert.equal(s.postpetition_days_delinquent, 47); assert.equal(s.over_45_sentence, true);
  const cyc = statementCycle(D("2027-01-01")); assert.equal(cyc.courtesy_period_end, "2027-01-16"); assert.equal(cyc.statement_due_by, "2027-01-20"); assert.equal(cyc.amount_due_date, "2027-02-01");
  // example C: contractual figures, no plan — 7 × $2,699.22 = $18,894.54; + $410.84 = $19,305.38; + $2,699.22 = $22,004.60; 199 days from Jun 2
  const c = exampleC();
  assert.equal(c.installment_display, "$2,699.22"); assert.equal(c.unpaid_installment_count, 7); assert.equal(c.unpaid_installments_cents, 1_889_454n); assert.equal(c.unpaid_installments_display, "$18,894.54"); assert.equal(c.unpaid_installments_cents, BigInt(c.unpaid_installment_count) * c.installment_cents);
  assert.equal(c.prepetition_late_charges_cents, 41_084n); assert.equal(c.prepetition_late_charges_display, "$410.84"); assert.equal(c.new_late_charges_cents, 0n);
  assert.equal(c.amount_to_bring_current_cents, 1_930_538n); assert.equal(c.amount_to_bring_current_display, "$19,305.38"); assert.equal(c.amount_to_bring_current_cents, c.unpaid_installments_cents + c.prepetition_late_charges_cents);
  assert.equal(c.amount_due_cents, 2_200_460n); assert.equal(c.amount_due_display, "$22,004.60"); assert.equal(c.amount_due_cents, c.amount_to_bring_current_cents + c.installment_cents); assert.equal(c.regx_days_delinquent, 199);
});
