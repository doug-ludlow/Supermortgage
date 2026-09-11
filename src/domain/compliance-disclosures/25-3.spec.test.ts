// 25.3 Right of rescission (refinances of principal dwellings): notice, period computation, waiver, confirmation of non-rescission, effect on funding, and rescission processing
// spec/sections/25-compliance-testing-the-closing-disclosure-rescission-and-clo/25-3-right-of-rescission-refinances-of-principal-dwellings-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { regzSpecific } from "../../kernel/calendar/business.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EscalationService } from "../../app/escalations.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { TOOLS_25_3 } from "../../app/tools/section25-3.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { EVALUATORS_25_3 } from "./evaluators-25-3.ts";
import { determineRescindability, newAdvanceCents, disbursementHold, computeRescissionPeriod, rescissionExpiry, servicingHandoffFields, materialDisclosureAccuracy, fundingReleaseDate, isFedwireOpen, rescissionGate, assertDisburseAllowed, disbursementTimingCompliance, sweepChannels, validateRescissionWaiver, acceptRescissionWaiver, evaluateExercise, recordExercise, unwindChecklist, completeUnwind, noticeAtSigningCheck, assertNoticeAtSigning, classifyInboundDocument, oralCancellationResponse, rescissionNoticePayload, templateCodeFor, perDiemInterestForDays, recordApplicability, recordNoticeDelivery, startPeriod, expirePeriod, confirmNotRescinded, closeMailAllowance, verifySigningPackage, RescissionRefused,
  type RescindabilityInput, type RescissionConsumer, type NoticeDelivery, type MaterialDisclosureDelivery, type RescissionPeriod, type WaiverStatementInput } from "./ops-25-3.ts";

const AGENT: Actor = { kind: "agent", id: "disclosure" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const APP = "APP-REFI-1";
const TZ = "America/Phoenix";
const PARTNER = "P-PARTNER";
/** The refinance fixture: $560,000.00 LCOR, Phoenix AZ; two spouses on title, one borrower; existing loan originated in 2021 by another lender (subserviced by SM). */
const CONSUMERS: RescissionConsumer[] = [{ consumer_id: "C-B", role: "borrower", ownership_interest: true, occupancy: "primary" }, { consumer_id: "C-S", role: "non_borrower_owner", ownership_interest: true, occupancy: "primary", ownership_basis: "spouse on title" }];
const H8_INPUT: RescindabilityInput = { application_id: APP, transaction_type: "limited_cash_out", consumers: CONSUMERS, partner_id: PARTNER, existing_loan: { original_creditor_id: "L-OTHER-2021", upb_cents: 54_820_000n, earned_unpaid_finance_charge_cents: 210_055n, refinancing_costs_cents: 795_000n }, amount_financed_cents: 55_615_005n };
const CONSUMMATION = "2026-11-06T17:30:00.000Z";   // 10:30 MST Fri Nov 6, 2026 (RON signing)
const CREDITOR = { creditor_name: "Partner Bank, N.A.", designated_address: "100 Partner Plaza, Suite 400, Phoenix AZ 85004" };
const signingNotices = (at = CONSUMMATION): NoticeDelivery[] => [{ consumer_id: "C-B", delivered_at: at, channel: "in_person", copies: 2, evidence_document_id: "DOC-RON-AUDIT-B" }, { consumer_id: "C-S", delivered_at: at, channel: "in_person", copies: 2, evidence_document_id: "DOC-RON-AUDIT-S" }];
const cdReceived = (on: string, cd_version = 1, accurate = true): MaterialDisclosureDelivery[] => [{ consumer_id: "C-B", cd_version, effective_receipt_date: D(on), accurate }, { consumer_id: "C-S", cd_version, effective_receipt_date: D(on), accurate }];
const fixturePeriod = (over: Partial<Parameters<typeof computeRescissionPeriod>[0]> = {}): RescissionPeriod =>
  computeRescissionPeriod({ application_id: APP, rescindability: determineRescindability(H8_INPUT), consummation_at: CONSUMMATION, time_zone: TZ, notice_deliveries: signingNotices(), material_disclosures: cdReceived("2026-11-02"), material_disclosures_accurate: true, ...over });

/** The 25.3 clocks over the overridden registry, in-memory events, a fixed clock, the escalation service. */
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["25.3"] });
  const escalations = new EscalationService(events, clock);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (t: string) => events.all().filter((e) => e.type === t);
  return { clock, events, timers, escalations, timer, ofType };
}
const toolKey = (process: string, name: string): string => `${process} ${name}`;
/** The 25.3 bus alone (the 12-8 pattern): TOOLS_25_3 bound to the `disclosure` agent. */
function busFor(h: ReturnType<typeof harness>) {
  const ctx: UowContext = { loanId: "", applicationId: APP, events: h.events, ledger: new MemoryLedger(), timers: h.timers, clock: h.clock, decide: () => {} };
  const agents = new AgentRegistry(); const rt: ToolRuntime = { store: new EntityStore(), ports: {}, escalations: h.escalations, services: {} };
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of TOOLS_25_3) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(toolKey(d.process, d.name), cmd); }
  const bus = new CommandBus(agents);
  const run = (name: string, input: ToolInput, actor: Actor = AGENT) => bus.execute(cmds.get(toolKey("25.3", name))!, actor, input, ctx);
  return { ctx, cmds, bus, rt, run };
}
/** Run the fixture through the bus up to a started period (T1's Given). */
async function startedOnBus(h: ReturnType<typeof harness>) {
  const b = busFor(h);
  await b.run("determineRescindability", { application_id: APP, transaction_type: "limited_cash_out", consumers: CONSUMERS, partner_id: PARTNER, existing_loan: { original_creditor_id: "L-OTHER-2021", upb_cents: "54820000", earned_unpaid_finance_charge_cents: "210055", refinancing_costs_cents: "795000" }, amount_financed_cents: "55615005" });
  const r = await b.run("computeRescissionPeriod", { application_id: APP, consummation_at: CONSUMMATION, time_zone: TZ, notice_deliveries: signingNotices(), material_disclosures: cdReceived("2026-11-02"), material_disclosures_accurate: true });
  return { ...b, period: r.output as RescissionPeriod & { handoff: ReturnType<typeof servicingHandoffFields> } };
}

test("25.3-T1: Given consummation Fri Nov 6, 2026 with H-8 copies delivered to both consumers at signing and CD v1 received Mon Nov 2, when `computeRescissionPeriod` runs, then `period_start_date = 2026-11-06`, `expires_at = 2026-11-10T24:00 MST`, `fundings.rescission_expires_at` matches, and `disburse` on Tue Nov 10 is refused.", async () => {
  const r = determineRescindability(H8_INPUT);
  assert.equal(r.applicability, "rescindable_full"); assert.equal(r.form, "h8"); assert.equal(r.original_creditor_match, false); assert.deepEqual(r.consumers.map((c) => c.consumer_id), ["C-B", "C-S"]);
  const p = fixturePeriod();
  // per consumer: max(consummation Fri Nov 6; notice Fri Nov 6; CD Mon Nov 2) = Fri Nov 6 — never consummation alone
  for (const c of p.consumers) { assert.equal(c.notice_delivered_on, "2026-11-06"); assert.equal(c.material_disclosures_received_on, "2026-11-02"); assert.equal(c.period_start_date, "2026-11-06"); }
  assert.equal(p.period_start_date, "2026-11-06");
  // count: Sat Nov 7 (1), Sun Nov 8 (excluded), Mon Nov 9 (2), Tue Nov 10 (3) → midnight ending Tue Nov 10 MST = 2026-11-11T07:00:00Z
  assert.equal(regzSpecific.isBusinessDay(D("2026-11-07")), true); assert.equal(regzSpecific.isBusinessDay(D("2026-11-08")), false);
  assert.equal(p.expires_on, "2026-11-10"); assert.equal(p.expires_at, "2026-11-11T07:00:00.000Z"); assert.equal(p.expires_display, "2026-11-10T24:00 MST"); assert.equal(p.status, "running");
  assert.deepEqual(rescissionExpiry(D("2026-11-06"), TZ), { expires_on: "2026-11-10", expires_at: "2026-11-11T07:00:00.000Z", expires_display: "2026-11-10T24:00 MST" });
  // fundings.rescission_expires_at = rescission_periods.expires_at (26.3 copies it; 30.2's OB-018 reads it at boarding)
  const handoff = servicingHandoffFields(p);
  assert.equal(handoff.rescission_expires_at, p.expires_at); assert.equal(handoff.rescindable, true); assert.equal(handoff.rescission_extended_until, null);
  // `disburse` on Tue Nov 10 (period running, sweep not run) is refused by the gate
  const facts = { status: p.status, expires_at: p.expires_at, reasonably_satisfied_at: null, waiver_id: null, now: "2026-11-10T20:00:00.000Z" };
  assert.equal(rescissionGate(facts).open, false);
  assert.throws(() => assertDisburseAllowed(facts), (e: unknown) => e instanceof RescissionRefused && e.code === "REGZ_1026_23_RESCISSION_3SBD_GATE" && /1026\.23\(c\)/.test(e.message));
  assert.equal(EVALUATORS_25_3["25.3.rescissionGateOpen"]!(facts).open, false);
  // through the bus: the rescission_periods row and the `rescission.period.started` event that arms the gate
  const h = harness("2026-11-06T17:35:00.000Z");
  const b = await startedOnBus(h);
  assert.equal(b.period.expires_at, "2026-11-11T07:00:00.000Z"); assert.equal(b.period.handoff.rescission_expires_at, "2026-11-11T07:00:00.000Z");
  const row = b.rt.store.get("rescission_periods", `${APP}:rescission`)!.data;
  assert.equal(row.period_start_date, "2026-11-06"); assert.equal(row.status, "running");
  const started = h.ofType("rescission.period.started"); assert.equal(started.length, 1); assert.equal(started[0]!.applicationId, APP); assert.equal(started[0]!.payload.period_start_date, "2026-11-06");
  const gate = h.timer("REGZ_1026_23_RESCISSION_3SBD_GATE")!;
  assert.equal(gate.status, "armed"); assert.equal(gate.anchorDate, "2026-11-06"); assert.equal(gate.note, "evaluator:25.3.rescissionGateOpen");
  // the guardrail: a period computed from consummation alone is refused before the handler runs
  await assert.rejects(b.run("computeRescissionPeriod", { application_id: APP, consummation_at: CONSUMMATION, from_consummation_only: true }), (e: unknown) => e instanceof CommandRefused && e.code === "PERIOD_NOT_FROM_CONSUMMATION_ALONE");
});

test("25.3-T2: Given T1 and a channel sweep on Wed Nov 11 08:00 MST finding nothing, then `reasonably_satisfied_at` is set, `REGZ_1026_23_RESCISSION_3SBD_GATE` opens, and the `funder` schedules the wire for Thu Nov 12 (Fedwire closed Nov 11); no Reg Z violation is recorded for the Nov 11 gap.", async () => {
  const h = harness("2026-11-06T17:35:00.000Z");
  const b = await startedOnBus(h);
  // midnight ending Tue Nov 10 → `rescission.period.expired` at the expiry instant arms the sweep (+8 h = 08:00 MST Wed Nov 11) and the 2-day mailed-notice allowance (Thu Nov 12)
  const expired = expirePeriod(h.events, b.period, "2026-11-11T07:00:00.000Z")!;
  assert.equal(expired.occurredAt, "2026-11-11T07:00:00.000Z"); assert.equal(expired.payload.expires_on, "2026-11-10");
  const sweep = h.timer("SM_O63_SATISFACTION_SWEEP")!, allowance = h.timer("SM_O63_MAILED_NOTICE_ALLOWANCE_2")!;
  assert.equal(sweep.status, "armed"); assert.equal(new Date(sweep.dueAt!).toISOString(), "2026-11-11T15:00:00.000Z");   // 08:00 MST
  assert.equal(allowance.status, "armed"); assert.equal(allowance.anchorDate, "2026-11-10"); assert.equal(allowance.dueDate, "2026-11-12");
  // the sweep at 08:00 MST: mail room (postmarks), e-mail, portal, fax — nothing received
  h.clock.set("2026-11-11T15:00:00.000Z");
  const r = await b.run("sweepInboundForRescission", { application_id: APP, swept_at: "2026-11-11T15:00:00.000Z", channels_checked: ["mail", "email", "portal", "fax", "voicemail"], items: [] });
  const out = r.output as { reasonably_satisfied_at: string | null; status: string; funding_release_at: string | null; sweep: ReturnType<typeof sweepChannels> };
  assert.equal(out.reasonably_satisfied_at, "2026-11-11T15:00:00.000Z"); assert.equal(out.sweep.satisfaction_basis, "channel_sweep"); assert.deepEqual(out.sweep.candidates, []); assert.equal(out.status, "expired_not_rescinded");
  assert.equal(h.timer("REGZ_1026_23_RESCISSION_3SBD_GATE")!.status, "satisfied"); assert.equal(h.timer("SM_O63_SATISFACTION_SWEEP")!.status, "satisfied");
  const confirmed = h.ofType("rescission.confirmed_not_rescinded"); assert.equal(confirmed.length, 1); assert.equal(confirmed[0]!.payload.reasonably_satisfied_at, "2026-11-11T15:00:00.000Z");
  const row = b.rt.store.get("rescission_periods", `${APP}:rescission`)!.data as unknown as RescissionPeriod;
  assert.equal(EVALUATORS_25_3["25.3.rescissionGateOpen"]!({ ...row, now: "2026-11-11T15:05:00.000Z" }).open, true);
  assert.doesNotThrow(() => assertDisburseAllowed({ status: row.status, expires_at: row.expires_at, reasonably_satisfied_at: row.reasonably_satisfied_at, waiver_id: null, now: "2026-11-11T15:05:00.000Z" }));
  // Wed Nov 11 is Veterans Day: Reg Z does not care about the disbursement day, but the Federal Reserve is closed → the funder schedules the wire for Thu Nov 12
  assert.equal(isFedwireOpen(D("2026-11-11")), false); assert.equal(isFedwireOpen(D("2026-11-12")), true);
  assert.equal(fundingReleaseDate({ expires_on: row.expires_on }).earliest_funding_date, "2026-11-12");
  assert.equal(out.funding_release_at, "2026-11-12T16:00:00.000Z"); assert.equal(confirmed[0]!.payload.earliest_funding_date, "2026-11-12");
  // no Reg Z violation for the Nov 11 gap: §1026.23(c) requires only expiry and reasonable satisfaction
  assert.deepEqual(disbursementTimingCompliance({ expires_at: row.expires_at, disbursed_at: "2026-11-12T15:30:00.000Z", reasonably_satisfied_at: row.reasonably_satisfied_at, waiver_id: null }), { compliant: true, violations: [] });
  assert.equal(disbursementTimingCompliance({ expires_at: row.expires_at, disbursed_at: "2026-11-10T20:00:00.000Z", reasonably_satisfied_at: null, waiver_id: null }).compliant, false);
  // the 2-day allowance keeps watching through Thu Nov 12, then closes with nothing received
  closeMailAllowance(h.events, row, "2026-11-12T15:00:00.000Z", []);
  assert.equal(h.timer("SM_O63_MAILED_NOTICE_ALLOWANCE_2")!.status, "satisfied");
  // guardrail: satisfaction is never asserted, only derived from the sweep
  await assert.rejects(b.run("sweepInboundForRescission", { application_id: APP, swept_at: "2026-11-11T15:00:00.000Z", channels_checked: ["mail", "email", "portal", "fax"], reasonably_satisfied_at: "2026-11-10T00:00:00.000Z" }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_RELEASE_BEFORE_EXPIRY");
});

test("25.3-T3: Given consummation Wed Nov 25, 2026, then `expires_at = 2026-11-30T24:00` (Thanksgiving Thu Nov 26 and Sun Nov 29 excluded; Sat Nov 28 counted) and disbursement is scheduled Tue Dec 1, 2026.", () => {
  const at = "2026-11-25T18:00:00.000Z";   // 11:00 MST Wed Nov 25 (the brief's "Thu Nov 25" does not exist)
  const p = fixturePeriod({ consummation_at: at, notice_deliveries: signingNotices(at), material_disclosures: cdReceived("2026-11-20") });
  assert.equal(p.period_start_date, "2026-11-25");
  assert.equal(regzSpecific.isBusinessDay(D("2026-11-26")), false);   // Thanksgiving
  assert.equal(regzSpecific.isBusinessDay(D("2026-11-27")), true);    // (1)
  assert.equal(regzSpecific.isBusinessDay(D("2026-11-28")), true);    // Sat (2)
  assert.equal(regzSpecific.isBusinessDay(D("2026-11-29")), false);   // Sun
  assert.equal(p.expires_on, "2026-11-30"); assert.equal(p.expires_display, "2026-11-30T24:00 MST"); assert.equal(p.expires_at, "2026-12-01T07:00:00.000Z");
  assert.equal(fundingReleaseDate({ expires_on: p.expires_on }).earliest_funding_date, "2026-12-01");
  // C2-2-01: first payment no later than two months after disbursement → Feb 1, 2027 at the latest; the platform sets Jan 1, 2027 with 31 days of per-diem interest (26.3 decides)
  const perDiem = perDiemInterestForDays(56_000_000n, "6.125", 31);
  assert.equal(perDiem.rounded_per_diem_cents, 9_397n);
});

test("25.3-T4: Given consummation Mon Nov 9, 2026, then `expires_at = 2026-11-13T24:00` (Veterans Day excluded) and disbursement is scheduled Mon Nov 16 (weekend).", () => {
  const at = "2026-11-09T18:00:00.000Z";
  const p = fixturePeriod({ consummation_at: at, notice_deliveries: signingNotices(at), material_disclosures: cdReceived("2026-11-05") });
  // Tue Nov 10 (1), Wed Nov 11 Veterans Day (excluded), Thu Nov 12 (2), Fri Nov 13 (3)
  assert.equal(regzSpecific.isBusinessDay(D("2026-11-11")), false);
  assert.equal(p.period_start_date, "2026-11-09"); assert.equal(p.expires_on, "2026-11-13"); assert.equal(p.expires_display, "2026-11-13T24:00 MST"); assert.equal(p.expires_at, "2026-11-14T07:00:00.000Z");
  // lawful on Sat Nov 14 under Reg Z; Fedwire closed on weekends → Mon Nov 16
  assert.equal(isFedwireOpen(D("2026-11-14")), false); assert.equal(isFedwireOpen(D("2026-11-15")), false);
  assert.equal(fundingReleaseDate({ expires_on: p.expires_on }).earliest_funding_date, "2026-11-16");
  // Saturday consummation edge case: Sat Nov 14 → Mon 16 (1), Tue 17 (2), Wed 18 (3)
  assert.equal(rescissionExpiry(D("2026-11-14"), TZ).expires_on, "2026-11-18");
});

test("25.3-T5: Given the non-borrower spouse's copies delivered Mon Nov 9 (courier receipt) after a Fri Nov 6 consummation, then her `period_start_date = 2026-11-09`, the loan `expires_at = 2026-11-13T24:00`, and funding moves to Mon Nov 16; given no delivery evidence for her at all, then `status = extended_3y` with `extended_expires_at = 2029-11-06` and `loans.rescission_extended_until` is set at boarding.", () => {
  const h = harness("2026-11-09T19:00:00.000Z");
  const late: NoticeDelivery[] = [signingNotices()[0]!, { consumer_id: "C-S", delivered_at: "2026-11-09T18:00:00.000Z", channel: "courier", copies: 2, evidence_document_id: "DOC-COURIER-SIGNED" }];
  const d = recordNoticeDelivery(h.events, APP, late[1]!, TZ);
  assert.equal(d.delivery.delivered_on, "2026-11-09"); assert.equal(d.event.type, "rescission.notice.delivered"); assert.equal(d.event.payload.copies, 2); assert.equal(d.event.applicationId, APP);
  const p = fixturePeriod({ notice_deliveries: late });
  const spouse = p.consumers.find((c) => c.consumer_id === "C-S")!, borrower = p.consumers.find((c) => c.consumer_id === "C-B")!;
  assert.equal(spouse.notice_delivered_on, "2026-11-09"); assert.equal(spouse.period_start_date, "2026-11-09"); assert.equal(spouse.expires_on, "2026-11-13");
  assert.equal(borrower.period_start_date, "2026-11-06");
  // the loan's expiry is the latest across consumers
  assert.equal(p.period_start_date, "2026-11-09"); assert.equal(p.expires_on, "2026-11-13"); assert.equal(p.expires_display, "2026-11-13T24:00 MST"); assert.equal(p.status, "running");
  assert.equal(fundingReleaseDate({ expires_on: p.expires_on }).earliest_funding_date, "2026-11-16");
  // no delivery evidence for her at all: the period never starts → extended_3y, consummation + 3 years
  assert.throws(() => recordNoticeDelivery(h.events, APP, { consumer_id: "C-S", delivered_at: "2026-11-09T18:00:00.000Z", channel: "courier", copies: 2, evidence_document_id: null }, TZ), (e: unknown) => e instanceof RescissionRefused && e.code === "NOTICE_DELIVERY_EVIDENCE");
  const none = fixturePeriod({ notice_deliveries: [signingNotices()[0]!] });
  assert.equal(none.status, "extended_3y"); assert.equal(none.period_start_date, null); assert.equal(none.expires_at, null); assert.equal(none.extended_expires_at, "2029-11-06");
  assert.deepEqual(none.defects, ["C-S: notice_not_delivered"]);
  const handoff = servicingHandoffFields(none);
  assert.equal(handoff.rescission_extended_until, "2029-11-06"); assert.equal(handoff.rescission_expires_at, null);
  // startPeriod flags the extended right → REGZ_1026_23_EXTENDED_RIGHT_3Y monitors to Tue Nov 6, 2029 (30.4 seeds RESCISSION_EXTENDED_WATCH from loans.rescission_extended_until)
  const flagged = startPeriod(h.events, none)!;
  assert.equal(flagged.type, "rescission.extended_right.flagged"); assert.equal(flagged.payload.rescission_extended_until, "2029-11-06");
  const monitor = h.timer("REGZ_1026_23_EXTENDED_RIGHT_3Y")!;
  assert.equal(monitor.status, "armed"); assert.equal(monitor.anchorDate, "2026-11-06"); assert.equal(monitor.dueDate, "2029-11-06");
  assert.equal(rescissionGate({ status: none.status, expires_at: null, reasonably_satisfied_at: null, waiver_id: null, now: "2026-12-01T00:00:00.000Z" }).open, false);
});

test("25.3-T6: Given a partner-originated existing loan with UPB $548,200.00, earned unpaid interest $2,100.55, refinancing costs $7,950.00 and amount financed $556,150.00, then `rescindable_amount_cents = -210055`, `applicability = exempt_same_creditor_no_new_money`, no notice is generated and `disburse` is not gated by rescission; given UPB $544,000.00, then `rescindable_amount_cents = 209945`, `form = h9`, and the H-9 states the increase of $2,099.45.", async () => {
  const same: RescindabilityInput = { ...H8_INPUT, existing_loan: { original_creditor_id: PARTNER, upb_cents: 54_820_000n, earned_unpaid_finance_charge_cents: 210_055n, refinancing_costs_cents: 795_000n }, amount_financed_cents: 55_615_000n };
  const r = determineRescindability(same);
  assert.equal(r.original_creditor_match, true); assert.equal(r.rescindable_amount_cents, -210_055n); assert.equal(r.applicability, "exempt_same_creditor_no_new_money"); assert.equal(r.form, "none"); assert.equal(r.gated, false);
  assert.throws(() => templateCodeFor(r.form), RangeError);   // no notice
  const p = computeRescissionPeriod({ application_id: APP, rescindability: r, consummation_at: CONSUMMATION, time_zone: TZ, notice_deliveries: [], material_disclosures: [], material_disclosures_accurate: true });
  assert.equal(p.status, "not_applicable"); assert.equal(p.expires_at, null);
  assert.doesNotThrow(() => assertDisburseAllowed({ status: p.status, expires_at: null, reasonably_satisfied_at: null, waiver_id: null, now: "2026-11-06T18:00:00.000Z" }));
  assert.deepEqual(disbursementHold(r, 55_615_000n), { held_cents: 0n, released_early_cents: 55_615_000n, basis: "not rescindable — no rescission hold" });
  const h = harness("2026-11-06T17:35:00.000Z");
  startPeriod(h.events, p);
  assert.equal(h.timers.all().length, 0);   // no gate
  // UPB $544,000.00 → new advance $2,099.45 → H-9 for the increase only
  const h9 = determineRescindability({ ...same, existing_loan: { ...same.existing_loan!, upb_cents: 54_400_000n } });
  assert.equal(h9.rescindable_amount_cents, 209_945n); assert.equal(h9.form, "h9"); assert.equal(h9.applicability, "rescindable_new_advance"); assert.equal(h9.gated, true);
  const payload = rescissionNoticePayload({ form: "h9", consumer_id: "C-B", consumer_name: "Alex Borrower", transaction_date: D("2026-11-06"), expires_on: D("2026-11-10"), creditor: CREDITOR, rescindable_amount_cents: h9.rescindable_amount_cents, property_address: "1234 W Camelback Rd, Phoenix AZ 85015", copies: 2 });
  assert.equal(payload.template_code, "NTC_REGZ_1026_23_H9"); assert.equal(payload.increase_cents, 209_945n);
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.versionsOf("NTC_REGZ_1026_23_H9")[0]!;
  const rendered = render(v.source, payload);
  assert.match(rendered.text, /The amount of the increase is \$2,099\.45/);
  assert.match(rendered.text, /no later than midnight of November 10, 2026/);
  assert.equal(evaluateChecklist(v, payload, rendered).passed, true);
  // the whole disbursement is still held (decision 25.3-Q3), and the agent may not split it
  assert.equal(disbursementHold(h9, 55_615_000n).held_cents, 55_615_000n);
  const b = busFor(h);
  await assert.rejects(b.run("determineRescindability", { application_id: APP, transaction_type: "limited_cash_out", consumers: CONSUMERS, partner_id: PARTNER, amount_financed_cents: "55615000", separate_disbursements: true }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_SEPARATE_H9_DISBURSEMENT");
  await assert.rejects(b.run("renderRescissionNotice", { application_id: APP, form: "h9", original_creditor_match: false, consumer_id: "C-B", consumer_name: "A", transaction_date: "2026-11-06", creditor_name: "P", designated_address: "x 85004", property_address: "y" }), (e: unknown) => e instanceof CommandRefused && e.code === "H9_ONLY_SAME_CREDITOR");
});

test("25.3-T7: Given a refinance of a second home (occupancy = second_home for every owner), then `applicability = not_principal_dwelling` and no notice or gate exists; given a purchase, `exempt_purchase_money`.", () => {
  const second = determineRescindability({ ...H8_INPUT, consumers: CONSUMERS.map((c) => ({ ...c, occupancy: "second_home" as const })) });
  assert.equal(second.applicability, "not_principal_dwelling"); assert.equal(second.form, "none"); assert.equal(second.gated, false); assert.deepEqual(second.consumers, []);
  assert.throws(() => templateCodeFor(second.form), RangeError);
  const h = harness("2026-11-06T17:35:00.000Z");
  const p = computeRescissionPeriod({ application_id: APP, rescindability: second, consummation_at: CONSUMMATION, time_zone: TZ, notice_deliveries: [], material_disclosures: [], material_disclosures_accurate: true });
  assert.equal(p.status, "not_applicable"); assert.equal(startPeriod(h.events, p), null); assert.equal(h.timers.all().length, 0);
  assert.equal(rescissionGate({ status: p.status, expires_at: null, reasonably_satisfied_at: null, waiver_id: null, now: CONSUMMATION }).open, true);
  // a cash-out refinance of a rental is not rescindable either; a co-owner who occupies the dwelling makes it rescindable as to that consumer (decision Q6)
  assert.equal(determineRescindability({ ...H8_INPUT, transaction_type: "cash_out", consumers: CONSUMERS.map((c) => ({ ...c, occupancy: "investment" as const })) }).applicability, "not_principal_dwelling");
  const mixed = determineRescindability({ ...H8_INPUT, consumers: [{ ...CONSUMERS[0]!, occupancy: "second_home" }, CONSUMERS[1]!] });
  assert.equal(mixed.applicability, "rescindable_full"); assert.deepEqual(mixed.consumers.map((c) => c.consumer_id), ["C-S"]);
  // purchase money: §1026.23(f)(1)
  const purchase = determineRescindability({ ...H8_INPUT, transaction_type: "purchase", existing_loan: null });
  assert.equal(purchase.applicability, "exempt_purchase_money"); assert.equal(purchase.form, "none"); assert.equal(purchase.gated, false);
});

test("25.3-T8: Given a consumer statement typed into a template with pre-printed waiver language, then `rescission_waivers` creation is rejected; given a dated, consumer-written, signed statement by both consumers accepted by `officer` on Sat Nov 7, then `status = waived` and `disburse` is permitted on Mon Nov 9 (Fedwire).", async () => {
  const h = harness("2026-11-07T16:00:00.000Z");
  const b = await startedOnBus(h);
  const own: WaiverStatementInput = { waiver_id: "W-1", rescission_id: `${APP}:rescission`, statement_document_id: "DOC-WAIVER-1", statement_text: "Nov 7, 2026. Our prior lender's payoff is due Monday and a foreclosure sale is set for Nov 10 unless it is paid; we waive our right to rescind this loan so it can fund now.", dated_on: D("2026-11-07"), signed_by: ["C-B", "C-S"], emergency_summary: "foreclosure sale on the existing lien set for Nov 10", received_at: "2026-11-07T15:00:00.000Z", consumer_written: true };
  // typed into a template with pre-printed waiver language → rejected (§1026.23(e) printed forms prohibited)
  const templated: WaiverStatementInput = { ...own, statement_text: "I/We hereby waive the right to rescind. Emergency: [describe emergency here] ________", template_used: true, consumer_written: false };
  assert.throws(() => validateRescissionWaiver(templated, ["C-B", "C-S"]), (e: unknown) => e instanceof RescissionRefused && e.code === "PRINTED_FORM");
  assert.throws(() => validateRescissionWaiver({ ...own, statement_text: "I/We hereby waive the right to rescind the transaction because of an emergency." }, ["C-B", "C-S"]), (e: unknown) => e instanceof RescissionRefused && e.code === "PRINTED_FORM");
  assert.throws(() => validateRescissionWaiver({ ...own, signed_by: ["C-B"] }, ["C-B", "C-S"]), (e: unknown) => e instanceof RescissionRefused && e.code === "ALL_CONSUMERS_SIGN");
  assert.throws(() => validateRescissionWaiver({ ...own, dated_on: null }, ["C-B", "C-S"]), (e: unknown) => e instanceof RescissionRefused && e.code === "WAIVER_UNDATED");
  await assert.rejects(b.run("computeRescissionPeriod", { application_id: APP, op: "accept_waiver", waiver: templated, accepted_at: "2026-11-07T17:00:00.000Z" }, OFFICER), (e: unknown) => e instanceof RescissionRefused && e.code === "PRINTED_FORM");
  assert.equal(b.rt.store.list("rescission_waivers").length, 0);
  // only officer accepts (the agent never suggests a waiver)
  await assert.rejects(b.run("computeRescissionPeriod", { application_id: APP, op: "accept_waiver", waiver: own, accepted_at: "2026-11-07T17:00:00.000Z" }), (e: unknown) => e instanceof CommandRefused && e.code === "WAIVER_ACCEPTED_BY_OFFICER");
  await assert.rejects(b.run("renderRescissionNotice", { application_id: APP, form: "h8", consumer_id: "C-B", consumer_name: "A", transaction_date: "2026-11-06", creditor_name: "P", designated_address: "x 85004", property_address: "y", include_waiver_text: true }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_WAIVER_LANGUAGE");
  assert.throws(() => acceptRescissionWaiver(h.events, b.period, own, AGENT, "2026-11-07T17:00:00.000Z"), (e: unknown) => e instanceof RescissionRefused && e.code === "WAIVER_OFFICER_ONLY");
  // a dated, consumer-written statement signed by both, accepted by officer Sat Nov 7 10:00 MST
  const r = await b.run("computeRescissionPeriod", { application_id: APP, op: "accept_waiver", waiver: own, accepted_at: "2026-11-07T17:00:00.000Z" }, OFFICER);
  const out = r.output as { status: string; funding_release_at: string; waiver: { accepted_by: string; accepted_on: string } };
  assert.equal(out.status, "waived"); assert.equal(out.waiver.accepted_by, "u-officer"); assert.equal(out.waiver.accepted_on, "2026-11-07");
  assert.equal(b.rt.store.get("rescission_waivers", "W-1")!.data.accepted_by, "u-officer");
  assert.equal(h.ofType("rescission.waiver.accepted").length, 1); assert.equal(h.ofType("rescission.waiver.received").length, 1);
  assert.equal(h.timer("REGZ_1026_23_RESCISSION_3SBD_GATE")!.status, "satisfied");
  // disburse permitted on Mon Nov 9 (Sat Nov 7 / Sun Nov 8: Fedwire closed)
  assert.equal(isFedwireOpen(D("2026-11-07")), false);
  assert.equal(fundingReleaseDate({ expires_on: b.period.expires_on, waiver_accepted_on: D("2026-11-07") }).earliest_funding_date, "2026-11-09");
  assert.equal(out.funding_release_at, "2026-11-09T16:00:00.000Z");   // 09:00 MST Mon Nov 9
  const row = b.rt.store.get("rescission_periods", `${APP}:rescission`)!.data as unknown as RescissionPeriod;
  assert.doesNotThrow(() => assertDisburseAllowed({ status: row.status, expires_at: row.expires_at, reasonably_satisfied_at: null, waiver_id: row.waiver_id, now: "2026-11-09T16:00:00.000Z" }));
  assert.equal(EVALUATORS_25_3["25.3.rescissionGateOpen"]!({ ...row, now: "2026-11-09T16:00:00.000Z" }).open, true);
  assert.deepEqual(disbursementTimingCompliance({ expires_at: row.expires_at, disbursed_at: "2026-11-09T16:00:00.000Z", reasonably_satisfied_at: null, waiver_id: row.waiver_id }), { compliant: true, violations: [] });
});

test("25.3-T9: Given a rescission notice postmarked Tue Nov 10 received Fri Nov 13 after a Thu Nov 12 disbursement, then `valid = true`, `refund_due_at = 2026-12-03`, an unwind checklist opens, and `REGZ_1026_23D2_RESCISSION_REFUND_20` breaches on Dec 4 if `rescission.unwind.completed` has not fired.", async () => {
  const h = harness("2026-11-13T18:00:00.000Z");
  const b = await startedOnBus(h);
  const r = await b.run("sweepInboundForRescission", { application_id: APP, op: "record_exercise", exercise_id: "X-1", consumer_id: "C-S", method: "mail", received_at: "2026-11-13T18:00:00.000Z", postmark_date: "2026-11-10", document_id: "DOC-RESCIND-1", disbursed_at: "2026-11-12T16:00:00.000Z", enote_registered: true, security_instrument_recorded: true });
  const out = r.output as { exercise: ReturnType<typeof evaluateExercise>; checklist: ReturnType<typeof unwindChecklist>; status: string };
  // a mailed notice is given when mailed: postmark Tue Nov 10 ≤ expiry Tue Nov 10 → valid even though received after funding
  assert.equal(out.exercise.valid, true); assert.equal(out.exercise.given_at, "2026-11-10"); assert.equal(out.exercise.received_on, "2026-11-13"); assert.equal(out.exercise.after_disbursement, true);
  assert.equal(out.exercise.refund_due_at, "2026-12-03"); assert.equal(out.exercise.status, "validated"); assert.equal(out.status, "rescinded");
  // one consumer's (the non-borrower spouse's) rescission rescinds the transaction for all
  assert.equal(b.rt.store.get("rescission_periods", `${APP}:rescission`)!.data.status, "rescinded");
  assert.ok(out.checklist.some((c) => /MERS eRegistry/.test(c.step)) && out.checklist.some((c) => /release \/ reconveyance/.test(c.step)) && out.checklist.some((c) => /reverse the payoff/.test(c.step)) && out.checklist.some((c) => /refund every amount/.test(c.step)));
  assert.ok(out.checklist.some((c) => c.step === "complete by 2026-12-03 (received 2026-11-13 + 20 calendar days)"));
  assert.equal(h.escalations.list().filter((e) => e.kind === "officer").length, 1);
  const received = h.ofType("rescission.notice.received")[0]!; assert.equal(received.payload.valid, true); assert.equal(received.payload.given_at, "2026-11-10");
  assert.equal(h.ofType("rescission.exercised").length, 1);
  const refund = h.timer("REGZ_1026_23D2_RESCISSION_REFUND_20")!;
  assert.equal(refund.status, "armed"); assert.equal(refund.anchorDate, "2026-11-13"); assert.equal(refund.dueDate, "2026-12-03");
  assert.deepEqual(h.timers.evaluate("2026-12-03T20:00:00.000Z").map((x) => x.def.code), []);
  const breaches = h.timers.evaluate("2026-12-04T12:00:00.000Z");
  assert.deepEqual(breaches.map((x) => x.def.code), ["REGZ_1026_23D2_RESCISSION_REFUND_20"]); assert.equal(breaches[0]!.severity, 1); assert.ok(breaches[0]!.escalateTo.includes("officer"));
  // the unwind completed in time satisfies the clock instead (officer sign-off)
  const h2 = harness("2026-11-13T18:00:00.000Z");
  const p2 = recordExercise(h2.events, fixturePeriod(), { exercise_id: "X-2", application_id: APP, consumer_id: "C-S", method: "mail", received_at: "2026-11-13T18:00:00.000Z", postmark_date: D("2026-11-10"), document_id: "DOC-RESCIND-1", written: true, disbursed_at: "2026-11-12T16:00:00.000Z" });
  assert.throws(() => completeUnwind(h2.events, p2.exercise, { completed_at: "2026-11-27T20:00:00.000Z", money_returned_at: "2026-11-25T20:00:00.000Z", security_terminated_at: "2026-11-27T19:00:00.000Z", release_document_id: "DOC-RECONVEY", enote_reversal_ref: "MERS-REV-1", refund_ledger_set_id: "LS-1", signed_off_by: AGENT }), (e: unknown) => e instanceof RescissionRefused && e.code === "UNWIND_OFFICER_SIGNOFF");
  const done = completeUnwind(h2.events, p2.exercise, { completed_at: "2026-11-27T20:00:00.000Z", money_returned_at: "2026-11-25T20:00:00.000Z", security_terminated_at: "2026-11-27T19:00:00.000Z", release_document_id: "DOC-RECONVEY", enote_reversal_ref: "MERS-REV-1", refund_ledger_set_id: "LS-1", signed_off_by: OFFICER });
  assert.equal(done.exercise.status, "closed"); assert.equal(done.event.payload.on_time, true);
  assert.equal(h2.timer("REGZ_1026_23D2_RESCISSION_REFUND_20")!.status, "satisfied");
  assert.deepEqual(h2.timers.evaluate("2026-12-04T12:00:00.000Z"), []);
  // a notice postmarked after expiry is not a valid exercise
  const late = evaluateExercise(fixturePeriod(), { exercise_id: "X-3", application_id: APP, consumer_id: "C-B", method: "mail", received_at: "2026-11-16T18:00:00.000Z", postmark_date: D("2026-11-12"), document_id: "DOC-LATE", written: true });
  assert.equal(late.valid, false); assert.match(late.invalid_reason!, /after the period expired 2026-11-10/);
});

test("25.3-T10: Given the CD's finance charge understated by $2,900.00 on the fixture (> $2,800.00 = 0.5% of $560,000), then `material_disclosures_accurate = false`, the period does not start until an accurate corrected CD is received, and the notice's printed expiry date is regenerated.", () => {
  const actual = 66_879_315n;   // 25.1's Appendix J finance charge on the fixture
  const g = materialDisclosureAccuracy({ disclosed_finance_charge_cents: actual - 290_000n, actual_finance_charge_cents: actual, face_amount_cents: 56_000_000n });
  assert.equal(g.tolerance_cents, 280_000n); assert.equal(g.understated_by_cents, 290_000n); assert.equal(g.accurate, false); assert.equal(g.basis, "g1i_half_pct_or_100"); assert.equal(g.citation, "§1026.23(g)(1)(i)");
  assert.equal(g.trid_o2.result, "fail");   // 25.1's §1026.38(o)(2) verdict rides alongside
  // 1 % applies only to a new-creditor refinance with no new advance (the fixture has a $2,000 cash-back → ½ %); $100 floor on small notes
  assert.equal(materialDisclosureAccuracy({ disclosed_finance_charge_cents: actual - 290_000n, actual_finance_charge_cents: actual, face_amount_cents: 56_000_000n, new_creditor_no_new_advance: true }).accurate, true);
  assert.equal(materialDisclosureAccuracy({ disclosed_finance_charge_cents: 1_000_000n - 9_000n, actual_finance_charge_cents: 1_000_000n, face_amount_cents: 1_000_000n }).tolerance_cents, 10_000n);
  assert.equal(materialDisclosureAccuracy({ disclosed_finance_charge_cents: actual + 500_000n, actual_finance_charge_cents: actual, face_amount_cents: 56_000_000n }).basis, "overstated");
  assert.equal(materialDisclosureAccuracy({ disclosed_finance_charge_cents: actual - 4_000n, actual_finance_charge_cents: actual, face_amount_cents: 56_000_000n, foreclosure_initiated: true }).accurate, false);
  // the period does not start: the inaccurate CD v1 is not "delivery of all material disclosures"
  const p = fixturePeriod({ material_disclosures_accurate: g.accurate });
  assert.equal(p.material_disclosures_accurate, false); assert.equal(p.status, "extended_3y"); assert.equal(p.period_start_date, null); assert.equal(p.expires_on, null);
  assert.match(p.defects[0]!, /material_disclosures_inaccurate/);
  assert.equal(rescissionGate({ status: p.status, expires_at: p.expires_at, reasonably_satisfied_at: null, waiver_id: null, now: "2026-11-12T16:00:00.000Z" }).open, false);
  // an accurate corrected CD (v2) received Mon Nov 9 starts the period from its receipt; the H-8's printed expiry is regenerated
  const corrected = fixturePeriod({ material_disclosures: [...cdReceived("2026-11-02", 1, false), ...cdReceived("2026-11-09", 2, true)], material_disclosures_accurate: true });
  assert.equal(corrected.status, "running"); assert.equal(corrected.period_start_date, "2026-11-09"); assert.equal(corrected.expires_on, "2026-11-13");
  const before = rescissionNoticePayload({ form: "h8", consumer_id: "C-B", consumer_name: "Alex Borrower", transaction_date: D("2026-11-06"), expires_on: D("2026-11-10"), creditor: CREDITOR, property_address: "1234 W Camelback Rd, Phoenix AZ 85015", copies: 2 });
  const after = rescissionNoticePayload({ form: "h8", consumer_id: "C-B", consumer_name: "Alex Borrower", transaction_date: D("2026-11-06"), expires_on: corrected.expires_on, creditor: CREDITOR, property_address: "1234 W Camelback Rd, Phoenix AZ 85015", copies: 2 });
  assert.equal(before.expiry_date, "2026-11-10"); assert.equal(after.expiry_date, "2026-11-13"); assert.notEqual(before.expiry_date, after.expiry_date);
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.versionsOf("NTC_REGZ_1026_23_H8")[0]!;
  assert.match(render(v.source, after).text, /midnight of November 13, 2026/);
  assert.equal(evaluateChecklist(v, after, render(v.source, after)).passed, true);
  // the notice cannot be rendered with no computed period (a blank or stale expiry is not a "properly completed" form)
  assert.throws(() => rescissionNoticePayload({ form: "h8", consumer_id: "C-B", consumer_name: "Alex Borrower", transaction_date: D("2026-11-06"), expires_on: p.expires_on, creditor: CREDITOR, property_address: "x", copies: 2 }), RangeError);
});

test("25.3-T11: Given an e-delivered H-8 under a valid E-SIGN consent, then the platform still records two copies per consumer (policy) and the compliance test accepts either 1 or 2; given paper delivery of one copy only, then `SM_O63_NOTICE_AT_SIGNING_GATE` blocks `consummate`.", () => {
  const consent = { id: "CONS-1", scope: ["disclosures"], granted_at: "2026-10-05T16:00:00.000Z" };
  const e = (copies: number) => ({ consumer_id: "C-B", copies, channel: "esign_portal" as const, esign_consent_id: "CONS-1", consent, delivered_at: CONSUMMATION, material_disclosures_in_package: true, receipt_capture: true });
  const two = noticeAtSigningCheck([e(2), { ...e(2), consumer_id: "C-S" }]);
  assert.equal(two.open, true); assert.deepEqual(two.per_consumer[0]!.compliance_copies_accepted, [1, 2]);
  assert.equal(noticeAtSigningCheck([e(1), { ...e(1), consumer_id: "C-S" }]).open, true);   // one electronic copy suffices under E-SIGN
  assert.equal(noticeAtSigningCheck([{ ...e(2), esign_consent_id: null }]).open, false);       // electronic without consent
  assert.equal(noticeAtSigningCheck([{ ...e(2), consent: { ...consent, revoked_at: "2026-11-01T00:00:00.000Z" } }]).open, false);
  // paper delivery of one copy only blocks `consummate`
  const paper = noticeAtSigningCheck([{ consumer_id: "C-B", copies: 1, channel: "in_person", material_disclosures_in_package: true, receipt_capture: true }, { consumer_id: "C-S", copies: 2, channel: "in_person", material_disclosures_in_package: true, receipt_capture: true }]);
  assert.equal(paper.open, false); assert.match(paper.reason!, /C-B — paper delivery requires two copies per consumer/); assert.deepEqual(paper.per_consumer[0]!.compliance_copies_accepted, [2]);
  assert.throws(() => assertNoticeAtSigning([{ consumer_id: "C-B", copies: 1, channel: "in_person", material_disclosures_in_package: true, receipt_capture: true }]), (e: unknown) => e instanceof RescissionRefused && e.code === "SM_O63_NOTICE_AT_SIGNING_GATE");
  assert.equal(noticeAtSigningCheck([{ consumer_id: "C-B", copies: 2, channel: "in_person", material_disclosures_in_package: false, receipt_capture: true }]).open, false);   // §1026.17(d): the CD to each rescinding consumer
  assert.equal(EVALUATORS_25_3["25.3.noticeAtSigningOpen"]!({ consumers: paper.per_consumer.map((p) => ({ consumer_id: p.consumer_id, copies: p.consumer_id === "C-B" ? 1 : 2, channel: "in_person", material_disclosures_in_package: true, receipt_capture: true })) }).open, false);
  assert.equal(EVALUATORS_25_3["25.3.noticeAtSigningOpen"]!({ consumers: [e(2)] }).open, true);
  // the gate arms on `closing.scheduled` and closes on the verified signing package; the platform records two copies even electronically (decision 25.3-Q1)
  const h = harness("2026-11-02T16:00:00.000Z");
  h.events.append({ type: "closing.scheduled", applicationId: APP, actor: AGENT, payload: { application_id: APP, closing_date: "2026-11-06", session_kind: "ron" } });
  const gate = h.timer("SM_O63_NOTICE_AT_SIGNING_GATE")!;
  assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:25.3.noticeAtSigningOpen");
  assert.equal(verifySigningPackage(h.events, APP, [{ consumer_id: "C-B", copies: 1, channel: "in_person", material_disclosures_in_package: true, receipt_capture: true }], CONSUMMATION).event, null);
  const ok = verifySigningPackage(h.events, APP, [e(2), { ...e(2), consumer_id: "C-S" }], CONSUMMATION);
  assert.equal(ok.event!.payload.copies_complete, true); assert.equal(h.timer("SM_O63_NOTICE_AT_SIGNING_GATE")!.status, "satisfied");
  const d = recordNoticeDelivery(h.events, APP, { consumer_id: "C-B", delivered_at: CONSUMMATION, channel: "esign_portal", copies: 2, evidence_document_id: "DOC-EDELIVERY-CERT", esign_consent_id: "CONS-1" }, TZ);
  assert.equal(d.delivery.copies, 2); assert.equal(d.event.payload.copies, 2);
  assert.throws(() => recordNoticeDelivery(h.events, APP, { consumer_id: "C-B", delivered_at: CONSUMMATION, channel: "in_person", copies: 1, evidence_document_id: "DOC-RON-AUDIT-B" }, TZ), (e: unknown) => e instanceof RescissionRefused && e.code === "NOTICE_COPIES");
});

test("25.3-T12: Given a phone call on day 3 at 23:30 saying \"I want to cancel\", then the call is logged as a rescission candidate, the consumer is sent the form and instructions within 5 minutes, and funding is held through the 2-day mail allowance.", async () => {
  const c = classifyInboundDocument({ text: "Hi, this is Sam — I want to cancel the loan we signed on Friday.", channel: "phone" });
  assert.equal(c.classification, "rescission_notice_candidate"); assert.equal(c.oral, true); assert.equal(c.valid_exercise_possible, false);
  assert.equal(classifyInboundDocument({ text: "Please treat this letter as my notice that I rescind the transaction.", channel: "mail" }).valid_exercise_possible, true);
  assert.equal(classifyInboundDocument({ text: "When is my first payment due?", channel: "email" }).classification, "other");
  assert.equal(classifyInboundDocument({ text: "I am having second thoughts about the loan documents I signed", channel: "portal" }).human_review, true);
  // day 3 = Tue Nov 10; 23:30 MST = 2026-11-11T06:30:00Z, half an hour before midnight
  const call_at = "2026-11-11T06:30:00.000Z";
  const h = harness(call_at);
  const b = await startedOnBus(h);
  h.clock.set(call_at);
  const r = await b.run("classifyInboundDocument", { application_id: APP, text: "I want to cancel", channel: "phone", received_at: call_at });
  const out = r.output as ReturnType<typeof classifyInboundDocument> & { response: ReturnType<typeof oralCancellationResponse>; escalation_id: string };
  assert.equal(out.classification, "rescission_notice_candidate");
  assert.equal(out.response.send_form_by, "2026-11-11T06:35:00.000Z");   // within 5 minutes
  assert.equal(out.response.exercise_deadline_text, "sign and send the form to the address on it by midnight of 2026-11-10");
  assert.equal(out.response.funding_hold_through, "2026-11-12"); assert.equal(out.response.valid_exercise, false);
  const logged = h.ofType("rescission.candidate.logged"); assert.equal(logged.length, 1); assert.equal(logged[0]!.payload.oral, true);
  assert.equal(h.escalations.list().find((e) => e.id === out.escalation_id)!.kind, "human_agent");
  assert.equal(b.rt.store.get("rescission_periods", `${APP}:rescission`)!.data.funding_hold_through, "2026-11-12");
  // funding is held through the 2-day mail allowance (here the same Thu Nov 12 the Fed calendar gives); the oral statement itself is not a valid exercise
  assert.equal(fundingReleaseDate({ expires_on: b.period.expires_on, hold_through_mail_allowance: true }).earliest_funding_date, "2026-11-12");
  assert.equal(fundingReleaseDate({ expires_on: D("2026-11-13"), hold_through_mail_allowance: true }).earliest_funding_date, "2026-11-16");
  assert.equal(evaluateExercise(b.period, { exercise_id: "X-oral", application_id: APP, consumer_id: "C-B", method: "hand", received_at: call_at, document_id: "CALL-1", written: false }).valid, false);
  // guardrail: "I want to cancel" is never classified as anything else
  await assert.rejects(b.run("classifyInboundDocument", { application_id: APP, text: "I want to cancel", channel: "phone", override_classification: "other" }), (e: unknown) => e instanceof CommandRefused && e.code === "CANCEL_IS_ALWAYS_A_CANDIDATE");
});

test("25.3 worked figures: examples A–E — the H-9 new-advance arithmetic ($548,200.00 / $2,100.55 / $7,950.00 = $3,850.00 + $4,100.00 / $556,150.00 → −$2,100.55; UPB $544,000.00 → $2,099.45 with $2,000.00 cash back), the (g) tolerances ($2,800.00 / $5,600.00) and the Thanksgiving per diem ($2,913.15)", () => {
  // worked example E: costs of the refinancing $3,850.00 + $4,100.00 = $7,950.00
  const costs = 385_000n + 410_000n;
  assert.equal(costs, 795_000n);
  const existing = { original_creditor_id: PARTNER, upb_cents: 54_820_000n, earned_unpaid_finance_charge_cents: 210_055n, refinancing_costs_cents: costs };
  assert.equal(newAdvanceCents(55_615_000n, existing), -210_055n);   // 556,150.00 − (548,200.00 + 2,100.55 + 7,950.00) = −2,100.55
  assert.equal(determineRescindability({ ...H8_INPUT, existing_loan: existing, amount_financed_cents: 55_615_000n }).applicability, "exempt_same_creditor_no_new_money");
  const h9 = determineRescindability({ ...H8_INPUT, existing_loan: { ...existing, upb_cents: 54_400_000n }, amount_financed_cents: 55_615_000n });
  assert.equal(h9.rescindable_amount_cents, 209_945n);   // 556,150.00 − (544,000.00 + 2,100.55 + 7,950.00) = 2,099.45
  // the $2,000.00 cash back to the borrower is smaller than the rescindable new advance, and the entire disbursement is held regardless (decision 25.3-Q3)
  const cashBack = 200_000n;
  assert.ok(cashBack < h9.rescindable_amount_cents!);
  assert.equal(disbursementHold(h9, 55_615_000n).held_cents, 55_615_000n); assert.notEqual(disbursementHold(h9, 55_615_000n).held_cents, cashBack);
  // (g)(1)(i): max(0.5 % × $560,000.00, $100) = $2,800.00; (g)(2)(i): 1 % = $5,600.00
  assert.equal(materialDisclosureAccuracy({ disclosed_finance_charge_cents: 0n, actual_finance_charge_cents: 0n, face_amount_cents: 56_000_000n }).tolerance_cents, 280_000n);
  assert.equal(materialDisclosureAccuracy({ disclosed_finance_charge_cents: 0n, actual_finance_charge_cents: 0n, face_amount_cents: 56_000_000n, new_creditor_no_new_advance: true }).tolerance_cents, 560_000n);
  // worked example B: Dec 1–31 = 31 days of per-diem interest on $560,000.00 at 6.125 %
  const pd = perDiemInterestForDays(56_000_000n, "6.125", 31);
  assert.equal(pd.rounded_per_diem_cents, 9_397n);            // 26.3 `365_rounded_per_diem` (25.1 fixture: 19 × $93.97 = $1,785.43)
  assert.equal(pd.total_unrounded_cents, 291_315n);           // the spec's $2,913.15 = 31 × 93.9726… rounded once at the end
  assert.equal(pd.total_rounded_per_diem_cents, 291_307n);    // spec discrepancy: under the platform's cent-rounded per diem convention 31 × $93.97 = $2,913.07, not $2,913.15
  // worked example A's refund clock: notice received Mon Nov 9, 2026 → due Sun Nov 29
  assert.equal(evaluateExercise(fixturePeriod(), { exercise_id: "X-A", application_id: APP, consumer_id: "C-B", method: "hand", received_at: "2026-11-09T18:00:00.000Z", document_id: "DOC-A", written: true }).refund_due_at, "2026-11-29");
});
