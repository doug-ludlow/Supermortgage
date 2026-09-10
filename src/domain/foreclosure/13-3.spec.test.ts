// 13.3 Foreclosure referral
// spec/sections/13-foreclosure/13-3-foreclosure-referral.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { referralPackage, nonPrReferral, mersAssignmentGate, ny1304, firmDocumentRequest, bankruptcyAfterReferral, reserveFallback, preSaleInspectionStop, transferredFirstFiling, thirdPartySaleSettlement, reinstatementAccepted, TPS_PROCEEDS_SETTLED } from "./ops.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { cents } from "../../kernel/money/cents.ts";
import { addBusinessDays, fannieEt, servicer } from "../../kernel/calendar/business.ts";
import { totalIndebtedness, bid, thirdPartySale, reinstatementQuote } from "./referral.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { ReferralLifecycle, saleAnchors, REFERRAL_SLA_DAYS } from "./ops-13-3.ts";
import { type Gates } from "./referral.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { TimerEngine, type TimerInstance } from "../../kernel/timers/engine.ts";
import { EscalationService } from "../../app/escalations.ts";
import { CommandBus, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { SECTION_13_TOOLS } from "../../app/tools/section13.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";

// ---- the 13.3 referral lifecycle (src/domain/foreclosure/ops-13-3.ts) over a TimerEngine on the overridden registry
// (only 13.3 rows arm): every timer below is armed by an event the lifecycle appends and satisfied by another — never by
// a literal. Federal holidays in play: 2026-07-03 (Independence Day observed), 2026-09-07 (Labor Day).
const LOAN = "L-133"; const CASE = "fc-133"; const FIRM = "firm-1";
const ALL_OPEN: Gates = { regx_120: true, regx_prefiling: true, no_first_filing_41k2: true, fnma_121: true, bk_stay: false, scra: false, dmdc_age_days: 3, disaster_approval: true, litigation_hold: false, environmental_hold: false, mn_dual_track: false, title_hold: false, package_ready: true };
function harness(startIso: string) {
  const clock = new FixedClock(startIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["13.3"] });
  const escalations = new EscalationService(events, clock);
  const lc = new ReferralLifecycle({ events, clock, escalations });
  const at = (iso: string) => clock.set(iso);
  const inst = (code: string, loanId = LOAN) => timers.byCode(code).filter((x) => x.subject.id === loanId);
  const armed = (code: string, due: string | undefined, loanId = LOAN): TimerInstance => { const t = inst(code, loanId).at(-1); assert.ok(t, `${code} armed for ${loanId}`); assert.equal(t.status, "armed", `${code} status`); assert.equal(t.dueDate, due, `${code} due`); return t; };
  const satisfied = (code: string, byType: string, loanId = LOAN): TimerInstance => { const t = inst(code, loanId).find((x) => x.status === "satisfied" || x.status === "satisfied_late"); assert.ok(t, `${code} satisfied`); const by = events.all().find((e) => e.id === t.satisfiedByEventId)!; assert.equal(by.type, byType, `${code} satisfied by ${byType}`); assert.ok(eventMatches(loadOverriddenRegistry().get(code)!.satisfiedPattern!, by), `${code}: the satisfying event carries every conditioned field`); return t; };
  const stillArmed = (code: string, loanId = LOAN): void => { assert.ok(inst(code, loanId).every((x) => x.status === "armed"), `${code} still armed`); };
  const triggerOf = (code: string, e: DomainEvent): boolean => eventMatches(loadOverriddenRegistry().get(code)!.triggerPattern!, e);
  return { clock, events, timers, escalations, lc, at, armed, satisfied, stillArmed, triggerOf };
}

test("13.3-T1: Given a principal residence, gates open on day 121 and review outcome `refer`, When `foreclosure.refer`, Then package sent with manifest hashes, `referral_sent_at` recorded, status 43 queued, firm ack timer 2 BD.", () => {
  const r = referralPackage({ referral_on: D("2026-06-30"), day: 121, principal_residence: true, review_outcome: "refer", documents: [{ id: "note", sha256: "a1" }, { id: "mortgage", sha256: "b2" }] });
  assert.equal(r.allowed, true); assert.deepEqual(r.manifest, [{ id: "note", sha256: "a1" }, { id: "mortgage", sha256: "b2" }]); assert.equal(r.referral_sent_at, "2026-06-30"); assert.equal(r.status_code, "43"); assert.equal(r.firm_ack_due, "2026-07-02");
  assert.equal(referralPackage({ referral_on: D("2026-06-29"), day: 120, principal_residence: true, review_outcome: "refer", documents: [{ id: "note", sha256: "a1" }] }).allowed, false);
});
test("13.3-T2: Given a non-principal residence at day 118 with review complete, Then referral must occur by day 120; if a complete BRP arrives day 119, E-3.2-04 postponement recorded and the deadline suspended.", () => {
  const a = nonPrReferral({ earliest_unpaid_due: D("2026-03-01"), today: D("2026-06-27") }); assert.equal(a.day, 118); assert.equal(a.refer_by, "2026-06-29"); assert.equal(a.postponement, null);
  const b = nonPrReferral({ earliest_unpaid_due: D("2026-03-01"), today: D("2026-06-28"), complete_brp_on: D("2026-06-28") }); assert.equal(b.postponement, "E-3.2-04"); assert.equal(b.deadline_suspended, true);
});
test("13.3-T3: Given MERS mortgagee and a pre-recordation state, When the assignment is unrecorded, Then `first_notice.authorize` refused; recorded ⇒ allowed on the first day all gates open.", () => {
  const r = mersAssignmentGate({ mers_mortgagee: true, pre_recordation_state: true, assignment_recorded_on: null, gates_open_on: D("2026-06-30") }); assert.equal(r.allowed, false); assert.match(r.refusal!, /unrecorded/);
  assert.deepEqual(mersAssignmentGate({ mers_mortgagee: true, pre_recordation_state: true, assignment_recorded_on: D("2026-06-10"), gates_open_on: D("2026-06-30") }), { allowed: true, allowed_from: "2026-06-30", refusal: null });
});
test("13.3-T4: Given NY, Then `NTC_STATE_PREFC_NY_1304` renders with ≥5 county agencies, certified + first-class mail evidence, §1306 filing within 3 BD; first notice refused before day 90.", () => {
  const r = ny1304({ mailed_on: D("2026-07-01"), county_agencies: ["a", "b", "c", "d", "e"], certified_mail_evidence: true, first_class_evidence: true, s1306_filed_on: D("2026-07-03"), first_notice_requested_on: D("2026-09-29") });
  assert.equal(r.checklist_passed, true); assert.equal(r.s1306_due, "2026-07-07"); assert.equal(r.s1306_on_time, true); assert.equal(r.first_notice_allowed_from, "2026-09-29"); assert.equal(r.first_notice_allowed, true);
  assert.equal(ny1304({ ...{ mailed_on: D("2026-07-01"), county_agencies: ["a", "b", "c", "d"], certified_mail_evidence: true, first_class_evidence: true, s1306_filed_on: D("2026-07-03"), first_notice_requested_on: D("2026-09-29") } }).checklist_passed, false);
  assert.equal(ny1304({ mailed_on: D("2026-07-01"), county_agencies: ["a", "b", "c", "d", "e"], certified_mail_evidence: true, first_class_evidence: true, s1306_filed_on: D("2026-07-03"), first_notice_requested_on: D("2026-09-28") }).first_notice_allowed, false);
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion("NTC_STATE_PREFC_NY_1304", D("2026-09-01"))!; const out = render(v.source, v.samplePayload);
  assert.match(out.text, /YOU MAY BE AT RISK OF FORECLOSURE/); assert.equal(evaluateChecklist(v, v.samplePayload, out).passed, true);
  const four = { ...v.samplePayload, agencies: ["a", "b", "c", "d"], agency_count: 4 }; assert.equal(evaluateChecklist(v, four, render(v.source, four)).passed, false);
  assert.equal(reg.template("NTC_STATE_PREFC_NY_1304").channelPolicy, "mail_only");
  // the mailing arms STATE_NY_RPAPL1306_DFS_FILING_3BD on `mailed_on` (+3 BD servicer over the 2026-07-03 holiday → 07-07) and the DFS receipt closes it
  const h = harness("2026-07-01T14:00:00.000Z");
  const agencies = ["Brooklyn Housing & Family Services", "Neighborhood Housing Services of Brooklyn", "CAMBA Inc.", "Bridge Street Development Corp.", "Cypress Hills Local Development Corp."];
  const certifiedOnly = h.lc.sendStatePreForeclosureNotice({ loan_id: LOAN, case_id: CASE, template: "NTC_STATE_PREFC_NY_1304", state: "NY", mailed_on: D("2026-07-01"), channels: [{ channel: "certified_mail", tracking: "9407 1234" }], county_agencies: agencies });
  assert.equal(certifiedOnly.ok, false); assert.match(certifiedOnly.refusal!, /certified and first-class/);
  const fourAgencies = h.lc.sendStatePreForeclosureNotice({ loan_id: LOAN, case_id: CASE, template: "NTC_STATE_PREFC_NY_1304", state: "NY", mailed_on: D("2026-07-01"), channels: [{ channel: "certified_mail", tracking: "9407 1234" }, { channel: "first_class" }], county_agencies: agencies.slice(0, 4) });
  assert.equal(fourAgencies.ok, false); assert.match(fourAgencies.refusal!, /at least 5/);
  assert.equal(h.timers.byCode("STATE_NY_RPAPL1306_DFS_FILING_3BD").length, 0, "a refused mailing arms nothing");
  const sent = h.lc.sendStatePreForeclosureNotice({ loan_id: LOAN, case_id: CASE, template: "NTC_STATE_PREFC_NY_1304", state: "NY", mailed_on: D("2026-07-01"), channels: [{ channel: "certified_mail", tracking: "9407 1234" }, { channel: "first_class" }], county_agencies: agencies, language: "English" });
  assert.equal(sent.ok, true); if (!sent.ok) return;
  assert.equal(sent.event.type, "notice.sent"); assert.equal(sent.event.payload.template, "NTC_STATE_PREFC_NY_1304"); assert.equal(sent.facts.s1306_due, "2026-07-07"); assert.equal(sent.facts.first_notice_not_before, "2026-09-29");
  assert.ok(h.triggerOf("STATE_NY_RPAPL1306_DFS_FILING_3BD", sent.event));
  h.armed("STATE_NY_RPAPL1306_DFS_FILING_3BD", "2026-07-07");
  h.at("2026-07-06T15:00:00.000Z");
  const filed = h.lc.recordStateFiling({ loan_id: LOAN, case_id: CASE, kind: "ny_dfs_1306", filed_on: D("2026-07-06"), receipt_id: "DFS-2026-000123", mailed_on: D("2026-07-01") });
  assert.equal(filed.ok, true); if (!filed.ok) return; assert.equal(filed.facts.on_time, true); assert.equal(filed.event.payload.kind, "ny_dfs_1306");
  h.satisfied("STATE_NY_RPAPL1306_DFS_FILING_3BD", "state.filing.completed");
  assert.equal(h.lc.recordStateFiling({ loan_id: LOAN, case_id: CASE, kind: "nj_something", filed_on: D("2026-07-06"), receipt_id: "x" }).ok, false);
});
test("13.3-T5: Given the worked bid example, Then bid = $281,509.46 with reserve $310,000; = $270,000.00 with reserve $270,000; transfer-tax state ⇒ incremental bidding from $100.", () => {
  const ti = totalIndebtedness({ upb_cents: cents("250000"), note_rate_pct: "6.50", lpi_due: D("2025-09-01"), sale_on: D("2026-11-03"), escrow_advances_cents: cents("6842.17"), corporate_advances_cents: cents("1975"), attorney_fees_cents: cents("2150"), costs_cents: cents("1487.50") });
  assert.equal(ti.days, 428); assert.equal(ti.interest_cents, cents("19054.79")); assert.equal(ti.total_cents, cents("281509.46"));
  assert.deepEqual(bid(ti.total_cents, cents("310000")), { opening_bid_cents: cents("281509.46"), max_bid_cents: cents("281509.46"), basis: "indebtedness" });
  assert.deepEqual(bid(ti.total_cents, cents("270000")), { opening_bid_cents: cents("270000"), max_bid_cents: cents("270000"), basis: "reserve" });
  const tt = bid(ti.total_cents, cents("310000"), true); assert.equal(tt.opening_bid_cents, cents("100")); assert.equal(tt.max_bid_cents, cents("281509.46"));
});
test("13.3-T6: Given a third-party sale at $290,000, Then surplus $8,490.54 booked, proceeds remitted within 5 BD of final payment, Action Code 71 in the sale month, closing statement sent same day.", () => {
  const ti = totalIndebtedness({ upb_cents: cents("250000"), note_rate_pct: "6.50", lpi_due: D("2025-09-01"), sale_on: D("2026-11-03"), escrow_advances_cents: cents("6842.17"), corporate_advances_cents: cents("1975"), attorney_fees_cents: cents("2150"), costs_cents: cents("1487.50") });
  assert.equal(thirdPartySale(cents("290000"), ti.total_cents).surplus_cents, cents("8490.54"));
  const s = thirdPartySaleSettlement({ sale_on: D("2026-11-03"), winning_bid_cents: cents("290000"), total_indebtedness_cents: ti.total_cents, final_payment_on: D("2026-11-03") });
  assert.equal(s.surplus_cents, cents("8490.54")); assert.equal(s.surplus_account, "tps_surplus_payable"); assert.equal(s.shortfall_cents, 0n); assert.equal(s.mi_claim, false);
  assert.equal(s.remit_by, addBusinessDays(D("2026-11-03"), 5, fannieEt)); assert.equal(s.remit_by, "2026-11-10"); assert.equal(s.timer, "FNMA_E3502_TPS_PROCEEDS_REMIT_5BD", "the proceeds clock runs from final payment (13.3 timer table); FNMA_E3502_TPS_DEPOSIT_REMIT_5BD belongs to a sale that fails to finalize");
  // the clock closes on the event the platform actually emits (15.1's CRS settlement), and the registry row is overridden to the same string so the two can never drift
  const timer = loadOverriddenRegistry().get("FNMA_E3502_TPS_PROCEEDS_REMIT_5BD")!; assert.equal(s.satisfied_by, TPS_PROCEEDS_SETTLED); assert.equal(timer.satisfied, TPS_PROCEEDS_SETTLED); assert.equal(timer.satisfiedPattern!.type, "remittance.special.settled"); assert.equal(timer.triggerPattern!.type, "tps.proceeds.received");
  assert.equal(s.action_code, "71"); assert.equal(s.action_code_period, "2026-11"); assert.equal(s.closing_statement_due, "2026-11-03");
  const short = thirdPartySaleSettlement({ sale_on: D("2026-11-03"), winning_bid_cents: cents("275000"), total_indebtedness_cents: ti.total_cents, final_payment_on: D("2026-11-03") }); assert.equal(short.shortfall_cents, cents("6509.46")); assert.equal(short.surplus_account, null); assert.equal(short.mi_claim, true);
});
test("13.3-T7: Given a full reinstatement tendered 2 days before sale, Then accepted, firm notified ≤2 BD (target same day), sale cancelled, note returned via Form 2009.", () => {
  const quote = reinstatementQuote({ delinquent_pi_cents: cents("8520.66"), late_charges_cents: cents("284.02"), escrow_advances_cents: cents("3105.40"), corporate_advances_cents: cents("60"), attorney_fees_cents: cents("1000"), costs_cents: cents("612") }); assert.equal(quote, cents("13582.08"));
  const r = reinstatementAccepted({ tendered_on: D("2026-11-01"), sale_on: D("2026-11-03"), quote_cents: quote, tendered_cents: quote, note_pulled: true });
  assert.equal(r.accepted, true); assert.equal(r.event, "loan.reinstated"); assert.equal(r.firm_notify_target, "2026-11-01"); assert.equal(r.firm_notify_by, addBusinessDays(D("2026-11-01"), 2, servicer)); assert.ok(r.firm_notify_by! <= "2026-11-03"); assert.equal(r.timer, "FNMA_E3206_WORKOUT_NOTIFY_FIRM_2BD");
  assert.deepEqual(r.instruction, { kind: "CANCEL_SALE", to: "firm", due: "2026-11-01", sent: true }); assert.equal(r.sale_cancelled, true); assert.equal(r.note_return, "Form 2009"); assert.equal(r.status_code_update, true);
  assert.equal(reinstatementAccepted({ tendered_on: D("2026-11-01"), sale_on: D("2026-11-03"), quote_cents: quote, tendered_cents: quote - 1n, note_pulled: true }).accepted, false);
  assert.equal(reinstatementAccepted({ tendered_on: D("2026-11-01"), sale_on: D("2026-11-03"), quote_cents: quote, tendered_cents: quote, note_pulled: false }).note_return, null);
  // the tender through the lifecycle: `loan.reinstated` (firm notified ≤2 BD, target same day), the sale cancelled, the case closed_reinstated, the note back via Form 2009
  const h = harness("2026-11-01T14:00:00.000Z");
  const short = h.lc.reinstatementTendered({ loan_id: LOAN, case_id: CASE, firm_id: FIRM, tendered_on: D("2026-11-01"), sale_on: D("2026-11-03"), quote_cents: quote, tendered_cents: quote - 1n, note_pulled: true });
  assert.equal(short.ok, false); assert.match(short.refusal!, /short of the quote/); assert.equal(h.events.all().length, 0, "a refused tender appends nothing");
  const ok = h.lc.reinstatementTendered({ loan_id: LOAN, case_id: CASE, firm_id: FIRM, tendered_on: D("2026-11-01"), sale_on: D("2026-11-03"), quote_cents: quote, tendered_cents: quote, note_pulled: true });
  assert.equal(ok.ok, true); if (!ok.ok) return;
  assert.deepEqual(ok.events.map((e) => e.type), ["loan.reinstated", "foreclosure.sale.cancelled", "foreclosure.case.closed", "note.returned"]);
  assert.equal(ok.event.payload.firm_notify_target, "2026-11-01"); assert.equal(ok.event.payload.firm_notify_by, "2026-11-03"); assert.equal(ok.event.payload.days_before_sale, 2); assert.equal(ok.event.payload.tendered_cents, "1358208");
  assert.equal(ok.events[1]!.payload.reason, "reinstated"); assert.equal(ok.events[2]!.payload.reason, "closed_reinstated"); assert.equal(ok.events[3]!.payload.form, "Form 2009");
  assert.ok(ok.events.slice(1).every((e) => e.causationId === ok.event.id), "the cancellation, closure and note return are caused by the reinstatement");
});
test("13.3-T8: Given the firm requests a document, When 3 BD pass without response, Then sev-1 escalation and comp-fee exposure flagged.", () => {
  const r = firmDocumentRequest({ requested_on: D("2026-07-06"), fulfilled_on: null, today: D("2026-07-10") });
  assert.equal(r.due, "2026-07-09"); assert.equal(r.breached, true); assert.equal(r.escalation!.severity, "sev1"); assert.equal(r.comp_fee_exposure_flag, true);
  assert.equal(firmDocumentRequest({ requested_on: D("2026-07-06"), fulfilled_on: D("2026-07-08"), today: D("2026-07-10") }).breached, false);
  // the firm's DOCUMENT_REQUEST arms FNMA_E3205_MISSING_DOCS_3BD (+3 BD servicer from the request); the lapse breaches it (sev 1) and flags the comp-fee exposure
  const h = harness("2026-07-06T14:00:00.000Z");
  const req = h.lc.ingestFirmDocumentRequest({ loan_id: LOAN, case_id: CASE, firm_id: FIRM, request_id: "dr-1", items: ["allonge", "lost note affidavit"], requested_on: D("2026-07-06") });
  assert.equal(req.ok, true); if (!req.ok) return; assert.equal(req.facts.due_on, "2026-07-09"); assert.equal(req.event.payload.request, "2026-07-06");
  h.armed("FNMA_E3205_MISSING_DOCS_3BD", "2026-07-09");
  assert.equal(h.lc.ingestFirmDocumentRequest({ loan_id: LOAN, case_id: CASE, firm_id: FIRM, request_id: "dr-2", items: [], requested_on: D("2026-07-06") }).ok, false, "an empty request is refused");
  const breaches = h.timers.evaluate("2026-07-10T12:00:00.000Z");
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.def.code, "FNMA_E3205_MISSING_DOCS_3BD"); assert.equal(breaches[0]!.severity, 1);
  const b = h.lc.documentRequestBreach({ loan_id: LOAN, case_id: CASE, request_id: "dr-1", requested_on: D("2026-07-06"), fulfilled_on: null, today: D("2026-07-10") });
  assert.equal(b.breached, true); assert.equal(b.escalation!.severity, "sev1"); assert.equal(h.escalations.opened[0]!.kind, "sev1"); assert.equal(h.escalations.opened[0]!.id, b.escalation_id);
  assert.equal(b.event!.type, "comp_fee_exposure.flagged"); assert.equal(b.event!.payload.kind, "missing_documents");
  // the late DOCUMENTS message still closes the clock, as satisfied_late
  const late = h.lc.sendDocumentsToFirm({ loan_id: LOAN, case_id: CASE, firm_id: FIRM, request_id: "dr-1", documents: [{ id: "allonge", sha256: "ab12" }, { id: "lna", sha256: "cd34" }], sent_on: D("2026-07-10"), requested_on: D("2026-07-06") });
  assert.equal(late.ok, true); if (!late.ok) return; assert.equal(late.facts.on_time, false);
  assert.equal(h.satisfied("FNMA_E3205_MISSING_DOCS_3BD", "attorney.documents.sent").status, "satisfied_late");
});
test("13.3-T9: Given a bankruptcy filed after referral, Then firm notified within 1 BD, case `on_hold_bankruptcy`, referral-back on relief to the same firm.", () => {
  const a = bankruptcyAfterReferral({ firm_id: "firm-1", petition_on: D("2026-08-03") }); assert.equal(a.notify_firm_by, "2026-08-04"); assert.equal(a.case_status, "on_hold_bankruptcy"); assert.equal(a.referral_back_to, null);
  const b = bankruptcyAfterReferral({ firm_id: "firm-1", petition_on: D("2026-08-03"), relief_on: D("2026-10-01") }); assert.equal(b.case_status, "active"); assert.equal(b.referral_back_to, "firm-1");
});
test("13.3-T10: Given the reserve price expires before the rescheduled sale and no refresh is available in time, Then basis falls back to total indebtedness and the decision record explains why.", () => {
  const r = reserveFallback({ reserve_cents: 31_000_000n, reserve_expires_on: D("2026-11-20"), sale_on: D("2026-12-08"), refresh_available_by: null, total_indebtedness_cents: 28_150_946n });
  assert.equal(r.basis, "indebtedness"); assert.equal(r.max_bid_cents, 28_150_946n); assert.match(r.rationale, /expired 2026-11-20 before the rescheduled sale 2026-12-08/);
  assert.equal(reserveFallback({ reserve_cents: 27_000_000n, reserve_expires_on: D("2026-11-20"), sale_on: D("2026-11-03"), refresh_available_by: null, total_indebtedness_cents: 28_150_946n }).basis, "reserve");
});
test("13.3-T11: Given the pre-sale inspection reports major uninsured fire damage, Then no bid is issued and a Servicing Representative contact task is created.", () => {
  const r = preSaleInspectionStop({ major_damage: true, insured: false, damage_kind: "fire damage" }); assert.equal(r.issue_bid, false); assert.equal(r.task!.kind, "servicing_representative_contact"); assert.match(r.task!.reason, /fire damage/);
  assert.equal(preSaleInspectionStop({ major_damage: true, insured: true }).issue_bid, true);
  const h = harness("2027-03-10T14:00:00.000Z");
  const ins = h.lc.recordPresaleInspection({ loan_id: LOAN, case_id: CASE, inspection_id: "insp-1", sale_at: D("2027-04-06"), inspected_on: D("2027-03-10"), major_damage: true, insured: false, damage_kind: "fire damage" });
  assert.equal(ins.ok, true); if (!ins.ok) return;
  assert.equal(ins.facts.issue_bid, false); assert.deepEqual(ins.events.map((e) => e.type), ["inspection.completed", "foreclosure.sale.bid.withheld"]);
  assert.equal(h.escalations.opened.length, 1); assert.equal(h.escalations.opened[0]!.id, ins.facts.task_id); assert.equal(h.escalations.opened[0]!.payload.task, "servicing_representative_contact"); assert.match(String(h.escalations.opened[0]!.payload.reason), /fire damage/);
});
test("13.3-T12: Given a transfer-in of a case with `first_notice_filed_at` evidenced, Then no state pre-foreclosure notice is re-sent and 13.5 uses the transferor's LPI date.", () => {
  const r = transferredFirstFiling({ transferor_first_notice_filed_at: D("2026-05-20"), transferor_state_prefc_notice_sent: true, transferor_lpi_due: D("2025-12-01") });
  assert.equal(r.resend_state_prefc_notice, false); assert.equal(r.timeframe_lpi_due, "2025-12-01"); assert.equal(r.second_first_notice_allowed, false);
});

test("13.3 worked figures: UPB $250,000.00 at 6.50% from LPI 2025-09-01 to sale 2026-11-03 (428 days) → interest $19,054.79; escrow advances $6,842.17, corporate advances $1,975.00, attorney fees $2,150.00, costs $1,487.50 → $281,509.46; reserve $270,000.00 → bid $270,000.00; sale $290,000.00 → surplus $8,490.54; reinstatement 6 × $1,420.11 = $8,520.66 + $284.02 + $3,105.40 + $60.00 + fees + $612.00", () => {
  const ti = totalIndebtedness({ upb_cents: 25000000n, note_rate_pct: "6.50", lpi_due: D("2025-09-01"), sale_on: D("2026-11-03"), escrow_advances_cents: 684217n, corporate_advances_cents: 197500n, attorney_fees_cents: 215000n, costs_cents: 148750n });
  assert.equal(ti.days, 428); assert.equal(ti.interest_cents, 1905479n); assert.equal(ti.total_cents, 28150946n);
  assert.equal(bid(ti.total_cents, 27000000n).max_bid_cents, 27000000n); assert.equal(bid(ti.total_cents, 31000000n).max_bid_cents, 28150946n); assert.equal(thirdPartySale(29000000n, ti.total_cents).surplus_cents, 849054n);
  assert.equal(6n * 142011n, 852066n); assert.equal(reinstatementQuote({ delinquent_pi_cents: 852066n, late_charges_cents: 28402n, escrow_advances_cents: 310540n, corporate_advances_cents: 6000n, attorney_fees_cents: 100000n, costs_cents: 61200n }), 1358208n);
});

test("13.3 timers: eligibility → referral → firm ACK → document and advance requests arm and close on the lifecycle's own events (SM_FC_REFER_WITHIN_5CD_OF_ELIGIBLE, FNMA_E3205_FIRM_ACK_2BD, FNMA_E3205_MISSING_DOCS_3BD, FNMA_E3205_ADVANCE_REQUEST_10BD)", () => {
  const h = harness("2026-09-10T14:00:00.000Z");
  const blocked = h.lc.referralEligible({ loan_id: LOAN, case_id: CASE, review_outcome: "refer", gates: { ...ALL_OPEN, dmdc_age_days: 31 }, today: D("2026-09-10"), principal_residence: true });
  assert.equal(blocked.ok, false); if (blocked.ok) return; assert.deepEqual(blocked.blocked_by, ["SCRA_DMDC_STALE_30"]); assert.equal(h.events.all().length, 0);
  const el = h.lc.referralEligible({ loan_id: LOAN, case_id: CASE, review_outcome: "refer", gates: ALL_OPEN, today: D("2026-09-10"), principal_residence: true });
  assert.equal(el.ok, true); if (!el.ok) return; assert.equal(el.event.type, "foreclosure.referral.eligible"); assert.equal(el.facts.eligibility_date, "2026-09-10"); assert.equal(el.facts.refer_by, "2026-09-15"); assert.equal(REFERRAL_SLA_DAYS, 5);
  h.armed("SM_FC_REFER_WITHIN_5CD_OF_ELIGIBLE", "2026-09-15");
  h.at("2026-09-14T14:00:00.000Z");
  const badHash = h.lc.sendReferralPackage({ loan_id: LOAN, case_id: CASE, firm_id: FIRM, referral_on: D("2026-09-14"), day: 121, principal_residence: true, review_outcome: "refer", documents: [{ id: "note", sha256: "not-hex" }] });
  assert.equal(badHash.ok, false); assert.match(badHash.refusal!, /SHA-256/);
  const early = h.lc.sendReferralPackage({ loan_id: LOAN, case_id: CASE, firm_id: FIRM, referral_on: D("2026-09-14"), day: 120, principal_residence: true, review_outcome: "refer", documents: [{ id: "note", sha256: "a1" }] });
  assert.equal(early.ok, false); h.stillArmed("SM_FC_REFER_WITHIN_5CD_OF_ELIGIBLE");
  const sent = h.lc.sendReferralPackage({ loan_id: LOAN, case_id: CASE, firm_id: FIRM, referral_on: D("2026-09-14"), day: 121, principal_residence: true, review_outcome: "refer", documents: [{ id: "note", sha256: "a1" }, { id: "mortgage", sha256: "b2" }], data_snapshot: { fnma_loan_number: "1234567890", military_status: "none" } });
  assert.equal(sent.ok, true); if (!sent.ok) return;
  assert.equal(sent.event.type, "foreclosure.referral.sent"); assert.equal(sent.event.payload.sent_at, "2026-09-14"); assert.equal(sent.facts.referral_sent_at, "2026-09-14"); assert.equal(sent.facts.status_code, "43"); assert.equal(sent.facts.firm_ack_due, "2026-09-16"); assert.equal(sent.event.payload.first_notice_authorized, false); assert.equal(sent.event.payload.fnma_owns_or_securitizes, true);
  h.satisfied("SM_FC_REFER_WITHIN_5CD_OF_ELIGIBLE", "foreclosure.referral.sent");
  h.armed("FNMA_E3205_FIRM_ACK_2BD", "2026-09-16");
  h.at("2026-09-15T14:00:00.000Z");
  assert.equal(h.lc.ingestFirmAck({ loan_id: LOAN, case_id: CASE, referral_id: sent.facts.referral_id, firm_id: FIRM, acknowledged_on: D("2026-09-15"), complete: false, missing: [] }).ok, false, "an incomplete ACK names the missing items");
  assert.equal(h.lc.ingestFirmAck({ loan_id: LOAN, case_id: CASE, referral_id: sent.facts.referral_id, firm_id: FIRM, acknowledged_on: D("2026-09-15"), complete: true, missing: ["allonge"] }).ok, false);
  const ack = h.lc.ingestFirmAck({ loan_id: LOAN, case_id: CASE, referral_id: sent.facts.referral_id, firm_id: FIRM, acknowledged_on: D("2026-09-15"), complete: false, missing: ["allonge"], message_seq: 2, sent_at: D("2026-09-14") });
  assert.equal(ack.ok, true); if (!ack.ok) return;
  assert.deepEqual(ack.events.map((e) => e.type), ["firm.referral.acknowledged", "foreclosure.referral.acknowledged", "firm.document.requested"]); assert.equal(ack.facts.on_time, true); assert.equal(ack.facts.ack_due, "2026-09-16");
  h.satisfied("FNMA_E3205_FIRM_ACK_2BD", "firm.referral.acknowledged");
  // the incomplete ACK is the firm's document request: 3 BD servicer from 09-15 → 09-18
  assert.equal(ack.facts.document_request!.payload.due_on, "2026-09-18"); h.armed("FNMA_E3205_MISSING_DOCS_3BD", "2026-09-18");
  h.at("2026-09-17T14:00:00.000Z");
  const docs = h.lc.sendDocumentsToFirm({ loan_id: LOAN, case_id: CASE, firm_id: FIRM, request_id: String(ack.facts.document_request!.payload.request_id), documents: [{ id: "allonge", sha256: "ab12" }], sent_on: D("2026-09-17"), requested_on: D("2026-09-15") });
  assert.equal(docs.ok, true); if (!docs.ok) return; assert.equal(docs.facts.on_time, true);
  assert.equal(h.satisfied("FNMA_E3205_MISSING_DOCS_3BD", "attorney.documents.sent").status, "satisfied");
  // ADVANCE_REQUEST{amount}: answered within 10 BD servicer (09-17 → 10-01)
  assert.equal(h.lc.ingestFirmAdvanceRequest({ loan_id: LOAN, case_id: CASE, firm_id: FIRM, request_id: "adv-1", amount_cents: 0n, purpose: "publication", requested_on: D("2026-09-17") }).ok, false);
  const adv = h.lc.ingestFirmAdvanceRequest({ loan_id: LOAN, case_id: CASE, firm_id: FIRM, request_id: "adv-1", amount_cents: cents("1500"), purpose: "publication costs", requested_on: D("2026-09-17") });
  assert.equal(adv.ok, true); if (!adv.ok) return; assert.equal(adv.facts.due_on, "2026-10-01"); assert.equal(adv.event.payload.amount_cents, "150000");
  h.armed("FNMA_E3205_ADVANCE_REQUEST_10BD", "2026-10-01");
  h.at("2026-09-25T14:00:00.000Z");
  assert.equal(h.lc.decideAdvanceRequest({ loan_id: LOAN, case_id: CASE, firm_id: FIRM, request_id: "adv-1", result: "declined", decided_on: D("2026-09-25") }).ok, false, "a decline carries its reason");
  assert.equal(h.lc.decideAdvanceRequest({ loan_id: LOAN, case_id: CASE, firm_id: FIRM, request_id: "adv-1", result: "funded", decided_on: D("2026-09-25") }).ok, false, "a funding carries the amount");
  const dec = h.lc.decideAdvanceRequest({ loan_id: LOAN, case_id: CASE, firm_id: FIRM, request_id: "adv-1", result: "funded", decided_on: D("2026-09-25"), amount_cents: cents("1500") });
  assert.equal(dec.ok, true); if (!dec.ok) return; assert.equal(dec.event.payload.result, "funded"); assert.equal(dec.event.payload.expense_claim_eligible, true);
  h.satisfied("FNMA_E3205_ADVANCE_REQUEST_10BD", "attorney.advance.decided");
});

test("13.3 timers: the NJ NOI mailing arms STATE_NJ_FFA_NOI_STALE_180 on mailed_on (+180 → 2027-03-17) and the complaint milestone closes it as `foreclosure.first_notice.filed`", () => {
  const h = harness("2026-09-18T14:00:00.000Z"); const NJ = "L-133-NJ";
  const noi = h.lc.sendStatePreForeclosureNotice({ loan_id: NJ, case_id: "fc-nj", template: "NTC_STATE_PREFC_NJ_NOI", state: "NJ", mailed_on: D("2026-09-18"), channels: [{ channel: "certified_mail", tracking: "7020 0090 RRR" }, { channel: "first_class" }] });
  assert.equal(noi.ok, true); if (!noi.ok) return; assert.equal(noi.facts.noi_stale_on, "2027-03-17"); assert.equal(noi.facts.first_notice_not_before, "2026-10-18");
  assert.ok(h.triggerOf("STATE_NJ_FFA_NOI_STALE_180", noi.event)); assert.ok(!h.triggerOf("STATE_NY_RPAPL1306_DFS_FILING_3BD", noi.event), "an NJ mailing arms no NY clock");
  h.armed("STATE_NJ_FFA_NOI_STALE_180", "2027-03-17", NJ); assert.equal(h.timers.byCode("STATE_NY_RPAPL1306_DFS_FILING_3BD").length, 0);
  assert.equal(h.lc.ingestFirmMilestone({ loan_id: NJ, case_id: "fc-nj", firm_id: FIRM, code: "SOMETHING_ELSE", occurred_on: D("2026-11-02"), source: "firm" }).ok, false);
  const title = h.lc.ingestFirmMilestone({ loan_id: NJ, case_id: "fc-nj", firm_id: FIRM, code: "TITLE_REVIEWED", occurred_on: D("2026-10-05"), source: "firm" });
  assert.equal(title.ok, true); if (!title.ok) return; assert.deepEqual(title.events.map((e) => e.type), ["foreclosure.milestone.recorded"]); h.stillArmed("STATE_NJ_FFA_NOI_STALE_180", NJ);
  h.at("2026-11-02T14:00:00.000Z");
  const complaint = h.lc.ingestFirmMilestone({ loan_id: NJ, case_id: "fc-nj", firm_id: FIRM, code: "COMPLAINT_FILED", occurred_on: D("2026-11-02"), source: "dra", evidence_document_id: "doc-complaint" });
  assert.equal(complaint.ok, true); if (!complaint.ok) return; assert.deepEqual(complaint.events.map((e) => e.type), ["foreclosure.milestone.recorded", "foreclosure.first_notice.filed"]); assert.equal(complaint.events[1]!.payload.filed_on, "2026-11-02");
  h.satisfied("STATE_NJ_FFA_NOI_STALE_180", "foreclosure.first_notice.filed", NJ);
});

test("13.3 timers: the firm's SALE_SCHEDULED anchors the E-3.x clocks on sale_at 2027-04-06 (outreach −60, review −30, inspection −35, valuation −90..−10, reserve −90..−30, bid −5 BD) and each closes on the lifecycle's event; the sale completion arms the 14-day insurance cancellation", () => {
  const h = harness("2026-12-01T14:00:00.000Z"); const SALE = D("2027-04-06");
  assert.equal(h.lc.ingestFirmSaleScheduled({ loan_id: LOAN, case_id: CASE, firm_id: FIRM, sale_at: SALE, method: "by_advertisement" }).ok, false);
  const a = saleAnchors(SALE, "judicial");
  assert.deepEqual(a, { outreach_stop_on: "2027-02-05", presale_review_due: "2027-03-07", inspection_window_opens: "2027-03-02", valuation_order_opens: "2027-01-06", reserve_window_opens: "2027-01-06", reserve_window_closes: "2027-03-07", bid_instructions_due: "2027-03-30" });
  assert.equal(saleAnchors(SALE, "non_judicial").outreach_stop_on, "2027-03-07");
  const sched = h.lc.ingestFirmSaleScheduled({ loan_id: LOAN, case_id: CASE, firm_id: FIRM, sale_at: SALE, method: "judicial", message_seq: 7 });
  assert.equal(sched.ok, true); if (!sched.ok) return; assert.equal(sched.event.type, "foreclosure.sale.scheduled"); assert.equal(sched.event.payload.sale_at, SALE); assert.equal(sched.event.payload.outreach_stop_on, "2027-02-05"); assert.equal(sched.event.payload.status_code_queued, "71");
  h.armed("FNMA_E3206_OUTREACH_STOP_60_30", "2027-02-05"); h.armed("FNMA_E3301_PRESALE_REVIEW_30", "2027-03-07"); h.armed("FNMA_E3303_PRESALE_INSPECTION_35", "2027-03-02");
  const val = h.armed("FNMA_E3305_VALUATION_ORDER_WINDOW_90", "2027-03-27"); assert.equal(val.note, "window opens 2027-01-06");
  const res = h.armed("FNMA_E3305_RESERVE_PRICE_WINDOW_30_90", "2027-03-07"); assert.equal(res.note, "window opens 2027-01-06");
  h.armed("FNMA_E3205_BID_INSTRUCTIONS_5BD", "2027-03-30");
  // E-3.3-05: no valuation order before sale −90; no reserve request outside −90..−30
  h.at("2027-01-05T14:00:00.000Z");
  assert.match(h.lc.orderValuation({ loan_id: LOAN, case_id: CASE, order_id: "val-1", sale_at: SALE, ordered_on: D("2027-01-05") }).refusal!, /no earlier than 90 days/);
  assert.match(h.lc.requestReservePrice({ loan_id: LOAN, case_id: CASE, request_id: "rp-1", sale_at: SALE, requested_on: D("2027-01-05") }).refusal!, /30–90-day window/);
  assert.match(h.lc.requestReservePrice({ loan_id: LOAN, case_id: CASE, request_id: "rp-1", sale_at: SALE, requested_on: D("2027-03-08") }).refusal!, /30–90-day window/);
  h.at("2027-01-08T14:00:00.000Z");
  const ord = h.lc.orderValuation({ loan_id: LOAN, case_id: CASE, order_id: "val-1", sale_at: SALE, ordered_on: D("2027-01-08") }); assert.equal(ord.ok, true); if (!ord.ok) return; assert.equal(ord.facts.result_expected_by, "2027-01-18");
  const rq = h.lc.requestReservePrice({ loan_id: LOAN, case_id: CASE, request_id: "rp-1", sale_at: SALE, requested_on: D("2027-01-08") }); assert.equal(rq.ok, true); if (!rq.ok) return; assert.equal(rq.event.payload.reason_code, "Reserve Price Bid Instructions");
  h.at("2027-01-15T14:00:00.000Z");
  const vr = h.lc.ingestValuationResult({ loan_id: LOAN, case_id: CASE, order_id: "val-1", received_on: D("2027-01-15"), value_cents: cents("315000") }); assert.equal(vr.ok, true);
  h.satisfied("FNMA_E3305_VALUATION_ORDER_WINDOW_90", "fnma.valuation.result.received");
  // a reserve that expires before the sale is not "unexpired": the window stays open and the bid basis falls back (13.3-T10)
  const expired = h.lc.ingestReservePrice({ loan_id: LOAN, case_id: CASE, request_id: "rp-1", sale_at: SALE, reserve_cents: cents("310000"), expires_on: D("2027-03-31"), received_on: D("2027-01-15") });
  assert.equal(expired.ok, true); if (!expired.ok) return; assert.equal(expired.facts.unexpired, false); h.stillArmed("FNMA_E3305_RESERVE_PRICE_WINDOW_30_90");
  assert.equal(h.lc.bidBasis({ reserve_cents: cents("310000"), reserve_expires_on: D("2027-03-31"), sale_on: SALE, refresh_available_by: null, total_indebtedness_cents: cents("281509.46") }).basis, "indebtedness");
  const fresh = h.lc.ingestReservePrice({ loan_id: LOAN, case_id: CASE, request_id: "rp-1", sale_at: SALE, reserve_cents: cents("310000"), expires_on: D("2027-04-20"), received_on: D("2027-01-20") });
  assert.equal(fresh.ok, true); if (!fresh.ok) return; assert.equal(fresh.facts.unexpired, true);
  h.satisfied("FNMA_E3305_RESERVE_PRICE_WINDOW_30_90", "fnma.reserve_price.received");
  // outreach ends 60 days before a judicial sale (E-3.2-06)
  h.at("2027-02-03T14:00:00.000Z");
  const out = h.lc.closeOutreachCampaign({ loan_id: LOAN, case_id: CASE, campaign_id: "camp-11x-1", closed_on: D("2027-02-03"), sale_at: SALE, method: "judicial" });
  assert.equal(out.ok, true); if (!out.ok) return; assert.equal(out.event.payload.reason, "sale_proximity"); assert.equal(out.facts.on_time, true);
  h.satisfied("FNMA_E3206_OUTREACH_STOP_60_30", "outreach.campaign.closed");
  // an inspection before sale −35 is not the pre-sale inspection (E-3.3-03 "within 35 days prior")
  h.at("2027-02-20T14:00:00.000Z");
  const tooEarly = h.lc.recordPresaleInspection({ loan_id: LOAN, case_id: CASE, inspection_id: "insp-0", sale_at: SALE, inspected_on: D("2027-02-20"), major_damage: false, insured: true });
  assert.equal(tooEarly.ok, true); if (!tooEarly.ok) return; assert.equal(tooEarly.facts.presale, false); assert.equal(tooEarly.facts.window_opens, "2027-03-02"); h.stillArmed("FNMA_E3303_PRESALE_INSPECTION_35");
  // the pre-sale review (E-3.3-01) at least 30 days before the sale
  h.at("2027-03-05T14:00:00.000Z");
  const hold = h.lc.completePresaleReview({ loan_id: LOAN, case_id: CASE, sale_at: SALE, completed_on: D("2027-03-05"), checks: { gates_open: true, scra_verified: false, bk_scrub_clear: true, holds_clear: true, bid_basis_ready: true } });
  assert.equal(hold.facts.result, "hold"); assert.deepEqual(hold.facts.failing, ["scra_verified"]); assert.equal(hold.facts.on_time, true);
  h.satisfied("FNMA_E3301_PRESALE_REVIEW_30", "foreclosure.presale_review.completed");
  h.at("2027-03-10T14:00:00.000Z");
  const insp = h.lc.recordPresaleInspection({ loan_id: LOAN, case_id: CASE, inspection_id: "insp-1", sale_at: SALE, inspected_on: D("2027-03-10"), major_damage: false, insured: true });
  assert.equal(insp.ok, true); if (!insp.ok) return; assert.equal(insp.facts.presale, true); assert.equal(insp.facts.issue_bid, true); assert.equal(h.escalations.opened.length, 0);
  h.satisfied("FNMA_E3303_PRESALE_INSPECTION_35", "inspection.completed");
  // E-3.5-02: the insurance-cancellation clock runs from the later of completion and confirmation
  h.at("2027-04-06T20:00:00.000Z");
  assert.match(h.lc.recordSaleCompleted({ loan_id: LOAN, case_id: CASE, sale_on: SALE, completed_on: SALE, outcome: "third_party", confirmation_required: true }).refusal!, /once confirmed/);
  assert.equal(h.timers.byCode("FNMA_E3502_INSURANCE_CANCEL_14").length, 0);
  h.at("2027-04-20T20:00:00.000Z");
  const done = h.lc.recordSaleCompleted({ loan_id: LOAN, case_id: CASE, sale_on: SALE, completed_on: SALE, outcome: "third_party", confirmation_required: true, confirmed_on: D("2027-04-20") });
  assert.equal(done.ok, true); if (!done.ok) return; assert.equal(done.event.type, "foreclosure.sale.completed"); assert.equal(done.facts.insurance_cancel_anchor_on, "2027-04-20"); assert.equal(done.facts.insurance_cancel_by, "2027-05-04");
  assert.ok(h.triggerOf("FNMA_E3502_INSURANCE_CANCEL_14", done.event)); h.armed("FNMA_E3502_INSURANCE_CANCEL_14", "2027-05-04");
  // 9.x / 15.1's cancellation request (src/app/tools/section15-1.ts) closes it
  h.at("2027-04-27T14:00:00.000Z");
  h.events.append({ type: "insurance.cancellation.requested", loanId: LOAN, actor: { kind: "agent", id: "reo-ops" }, payload: { policy_kind: "hazard", cancel_as_of: "2027-04-20", flow: "9.5" } });
  h.satisfied("FNMA_E3502_INSURANCE_CANCEL_14", "insurance.cancellation.requested");
});

test("13.3 bus: the inbound firm messages ride `attorney.instruction.status{op=firm_message}` and the servicer acts `attorney.message.send{op=fc.*}` — the ACK closes FNMA_E3205_FIRM_ACK_2BD and the DOCUMENTS message closes FNMA_E3205_MISSING_DOCS_3BD through the bus", async () => {
  const clock = new FixedClock("2026-09-14T14:00:00.000Z"); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["13.3"] });
  const ctx: UowContext = { loanId: LOAN, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push({ loanId: LOAN, ...d }); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const cmds = new Map<string, CommandSpec<ToolInput, unknown>>(); for (const d of SECTION_13_TOOLS) { const c = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, c.name); cmds.set(`${d.process} ${d.name}`, c); }
  const bus = new CommandBus(agents); const AGENT: Actor = { kind: "agent", id: "foreclosure-ops" };
  const run = async (process: string, tool: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => { const cmd = cmds.get(`${process} ${tool}`); assert.ok(cmd, `${process} ${tool} is on the bus`); return (await bus.execute(cmd, AGENT, input, ctx)).output as Record<string, unknown>; };
  const sent = await run("13.6", "attorney.message.send", { op: "fc.send_referral", loan_id: LOAN, case_id: CASE, firm_id: FIRM, day: 121, principal_residence: true, documents: [{ id: "note", sha256: "a1" }] });
  assert.equal(sent.event, "foreclosure.referral.sent"); assert.equal(sent.referral_sent_at, "2026-09-14"); assert.equal(rt.store.get("attorney_referrals", String(sent.referral_id))!.data.firm_id, FIRM); assert.equal(rt.store.get("foreclosure_cases", CASE)!.data.status, "referred");
  const ack = timers.byCode("FNMA_E3205_FIRM_ACK_2BD").at(-1)!; assert.equal(ack.status, "armed"); assert.equal(ack.dueDate, "2026-09-16");
  await assert.rejects(run("13.2", "attorney.instruction.status", { op: "firm_message", kind: "ACK", loan_id: LOAN, case_id: CASE, firm_id: FIRM, referral_id: sent.referral_id, complete: false, missing: [] }), (e: unknown) => e instanceof Error && /missing items/.test(e.message));
  clock.set("2026-09-15T14:00:00.000Z");
  const acked = await run("13.2", "attorney.instruction.status", { op: "firm_message", kind: "ACK", loan_id: LOAN, case_id: CASE, firm_id: FIRM, referral_id: sent.referral_id, complete: false, missing: ["allonge"], sent_at: "2026-09-14", message_seq: 2 });
  assert.deepEqual(acked.events, ["firm.referral.acknowledged", "foreclosure.referral.acknowledged", "firm.document.requested"]); assert.equal(ack.status, "satisfied");
  assert.equal(rt.store.get("attorney_referrals", String(sent.referral_id))!.data.ack_complete, false); assert.deepEqual(rt.store.get("attorney_referrals", String(sent.referral_id))!.data.missing_items, ["allonge"]);
  const docsTimer = timers.byCode("FNMA_E3205_MISSING_DOCS_3BD").at(-1)!; assert.equal(docsTimer.status, "armed"); assert.equal(docsTimer.dueDate, "2026-09-18");
  clock.set("2026-09-17T14:00:00.000Z");
  const docs = await run("13.6", "attorney.message.send", { op: "fc.send_documents", loan_id: LOAN, case_id: CASE, firm_id: FIRM, request_id: `${String(sent.referral_id)}-ack-missing`, documents: [{ id: "allonge", sha256: "ab12" }], requested_on: "2026-09-15" });
  assert.equal(docs.event, "attorney.documents.sent"); assert.equal(docs.on_time, true); assert.equal(docsTimer.status, "satisfied");
  await assert.rejects(run("13.6", "attorney.message.send", { op: "fc.nonsense", loan_id: LOAN, case_id: CASE }), (e: unknown) => e instanceof Error && /not a 13.3 act/.test(e.message));
  await assert.rejects(run("13.2", "attorney.instruction.status", { op: "firm_message", kind: "INVOICE", loan_id: LOAN, case_id: CASE, firm_id: FIRM }), (e: unknown) => e instanceof Error && /kind must be one of/.test(e.message));
});
