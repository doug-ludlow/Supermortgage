// 13.8 SCRA foreclosure protection
// spec/sections/13-foreclosure/13-8-scra-foreclosure-protection.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { boardingDmdc, openScraCase, affidavitGate, certificationDmdcCheck, dmdcOutageBeforeSale, zResult, saleInViolation, waiverRequest, protectionTail, scraCaseClose } from "./ops.ts";
import { protectionEndsOn, fcGateClosed, dmdcFresh, preServiceObligation } from "./scra.ts";
import { referralEligible, type Gates } from "./referral.ts";
import { gate120 } from "./gates.ts";
import { daysBetween, addDays } from "../../kernel/calendar/date.ts";
import { creditDelays } from "./timeframes.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { GateClosed } from "../../app/evaluators.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { SECTION_13_TOOLS } from "../../app/tools/section13.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, type TimerInstance } from "../../kernel/timers/engine.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";

// ---- the §13 tools on the bus with a TimerEngine over the overridden registry (only 13.8 rows arm): each timer a T-id
// names is armed by the event a tool appends and satisfied by the event the responding tool appends — never by a literal.
const LOAN = "L-138";
const AGENT: Actor = { kind: "agent", id: "foreclosure-ops" };
const ATTORNEY: Actor = { kind: "human", id: "u-attorney", role: "attorney" };
const SIGNER: Actor = { kind: "human", id: "u-signer", role: "signing_officer" };
const ANALYST: Actor = { kind: "human", id: "u-analyst", role: "ops_analyst" };
function bus(startIso: string, loanId = LOAN) {
  const clock = new FixedClock(startIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["13.8"] });
  const ctx: UowContext = { loanId, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push({ loanId, ...d }); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  // the §13 tools bound directly (not through src/app/tools/index.ts, so another section's build state cannot keep this file from loading)
  const agents = new AgentRegistry(); const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const cmds = new Map<string, CommandSpec<ToolInput, unknown>>(); for (const d of SECTION_13_TOOLS) { const c = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, c.name); cmds.set(`${d.process} ${d.name}`, c); }
  const cb = new CommandBus(agents);
  const run = async <O = Record<string, unknown>>(process: string, tool: string, actor: Actor, input: Record<string, unknown>, at?: string): Promise<O> => { const cmd = cmds.get(`${process} ${tool}`); assert.ok(cmd, `${process} ${tool} is on the bus`); return (await cb.execute(cmd, actor, input, ctx, at ? { now: at } : {})).output as O; };
  const types = (from = 0) => events.all().slice(from).map((e) => e.type);
  const armed = (code: string, due: string | undefined): TimerInstance => { const t = timers.byCode(code).filter((x) => x.subject.id === loanId).at(-1); assert.ok(t, `${code} armed for ${loanId}`); assert.equal(t.status, "armed", `${code} status`); assert.equal(t.dueDate, due, `${code} due`); return t; };
  const satisfied = (code: string, byType: string): TimerInstance => { const t = timers.byCode(code).filter((x) => x.subject.id === loanId).find((x) => x.status === "satisfied"); assert.ok(t, `${code} satisfied`); const by = events.all().find((e) => e.id === t.satisfiedByEventId)!; assert.equal(by.type, byType, `${code} satisfied by ${byType}`); assert.ok(eventMatches(loadOverriddenRegistry().get(code)!.satisfiedPattern!, by), `${code}: the satisfying event carries every conditioned field`); return t; };
  const put = (kind: string, id: string, data: Record<string, unknown>) => rt.store.put(kind, id, data, ATTORNEY, clock.now());
  return { clock, events, timers, rt, run, types, armed, satisfied, put };
}
const refused = (code: string) => (e: unknown) => e instanceof CommandRefused && e.code === code;
const gateClosed = (code: string) => (e: unknown) => e instanceof GateClosed && e.ref === code;

test("13.8-T1: Given a boarded loan, Then a DMDC verification exists within 5 BD; results parsed with certificate ids.", () => {
  const r = boardingDmdc({ boarded_on: D("2026-06-01"), results: [{ borrower_id: "b1", status: "N", certificate_id: "CERT-1", as_of: D("2026-06-03") }, { borrower_id: "b2", status: "N", certificate_id: "CERT-2", as_of: D("2026-06-03") }] });
  assert.equal(r.due, "2026-06-08"); assert.equal(r.verified, true); assert.deepEqual(r.parsed.map((p) => p.certificate_id), ["CERT-1", "CERT-2"]); assert.deepEqual(r.missing_certificate, []);
});
test("13.8-T2: Given a certificate 31 days old at referral, Then `foreclosure.refer` refused; a fresh certificate (N) allows it.", () => {
  const gates: Gates = { regx_120: true, regx_prefiling: true, no_first_filing_41k2: true, fnma_121: true, bk_stay: false, scra: false, dmdc_age_days: 31, disaster_approval: true, litigation_hold: false, environmental_hold: false, mn_dual_track: false, title_hold: false, package_ready: true };
  const stale = referralEligible("refer", gates); assert.equal(stale.ok, false); assert.deepEqual(stale.blocked_by, ["SCRA_DMDC_STALE_30"]);
  assert.equal(dmdcFresh(D("2026-05-30"), D("2026-06-30")), false, "31 days old"); assert.equal(dmdcFresh(D("2026-05-31"), D("2026-06-30")), true, "30 days old");
  const fresh = referralEligible("refer", { ...gates, dmdc_age_days: 0, scra: false }); assert.equal(fresh.ok, true); assert.deepEqual(fresh.blocked_by, []);
  assert.equal(referralEligible("hold_scra", { ...gates, dmdc_age_days: 0, scra: true }).ok, false, "a fresh certificate showing Y still refuses");
});
test("13.8-T3: Given DMDC Y on a pre-service obligation, Then `scra.case.opened`, gate closed, status 32 queued, late charges waived, firm instructed `SCRA_STAY` within 1 BD, quarterly contact timers set.", () => {
  const r = openScraCase({ dmdc_status: "Y", origination_on: D("2021-10-01"), service_begin_on: D("2026-03-15"), verified_on: D("2026-06-03"), late_charges_since_service_cents: 8_186n });
  assert.equal(r.opened, true); assert.equal(r.event, "scra.case.opened"); assert.equal(r.gate, "closed"); assert.equal(r.status_code, "32"); assert.equal(r.late_charges_waived_cents, 8_186n);
  assert.deepEqual(r.firm_instruction, { kind: "SCRA_STAY", to: "firm", due: "2026-06-04", sent: true });
  assert.equal(r.quarterly_timer, "FNMA_D23401_SM_CONTACT_90", "D2-3.4-01 quarterly borrower contact — not the DMDC re-verification cadence"); assert.deepEqual(r.timers, ["FNMA_D23401_SM_CONTACT_90", "SM_DMDC_PERIODIC_ACTIVE_FC_90"]); assert.equal(r.next_contact_on, "2026-09-01");
  assert.equal(openScraCase({ dmdc_status: "Y", origination_on: D("2026-05-01"), service_begin_on: D("2026-03-15"), verified_on: D("2026-06-03"), late_charges_since_service_cents: 0n }).opened, false);
});
test("13.8-T4: Given the worked timeline, Then `protection_ends_on` = Feb. 28, 2028 and referral is refused on Feb. 28, 2028 and allowed Mar. 1, 2028.", () => {
  // origination Mar. 1, 2024; active duty Mar. 15, 2026 – Feb. 28, 2027; delinquent from Apr. 1, 2026; day 121 = July 31, 2026
  assert.equal(preServiceObligation(D("2024-03-01"), D("2026-03-15")), true); assert.equal(gate120(D("2026-07-31"), D("2026-04-01"), true).state, "open"); assert.equal(fcGateClosed(D("2026-07-31"), null, true), true, "13.1 open but SCRA_3953C_FC_PROTECTION_GATE closed while on duty");
  assert.equal(protectionEndsOn(D("2027-02-28")), "2028-02-28");
  const close = scraCaseClose({ service_end_on: D("2027-02-28"), evidence: { orders_document_id: "orders-1" } }); assert.equal(close.allowed, true); assert.equal(close.basis, "orders"); assert.equal(close.status, "open_tail_12m"); assert.equal(close.protection_ends_on, "2028-02-28"); assert.equal(close.timer, "SCRA_3953_TAIL_1Y");
  // 2028 is a leap year: the day after the Feb. 28, 2028 protection end is Feb. 29, 2028 (the spec's "Mar. 1, 2028" is a calendar slip — Mar. 1 is also open, one day later)
  assert.equal(close.gate_opens_on, "2028-02-29");
  assert.equal(fcGateClosed(D("2028-02-28"), D("2027-02-28"), false), true, "referral refused on Feb. 28, 2028"); assert.equal(fcGateClosed(D("2028-02-29"), D("2027-02-28"), false), false, "allowed from the next calendar day"); assert.equal(fcGateClosed(D("2028-03-01"), D("2027-02-28"), false), false, "allowed Mar. 1, 2028");
  // status code 32 reported Apr. 2026 → Feb. 2028: the spec counts 699 days inclusive (daysBetween gives 698); 13.5 credits min(actual, 455) = 455 through the military_indulgence rule (first occurrence only)
  assert.equal(daysBetween(D("2026-04-01"), D("2028-02-28")), 698); assert.equal(daysBetween(D("2026-04-01"), D("2028-02-29")), 699, "the spec's 699 = the inclusive count through Feb. 28, 2028");
  const credit = creditDelays([{ category: "military_indulgence", from: D("2026-04-01"), to: D("2028-02-29"), reported_timely: true, status_code_reported: "32" }]);
  assert.equal(credit.credits[0]!.actual, 699); assert.equal(credit.credits[0]!.cap, 455); assert.equal(credit.credited_days, 455, "status 32 credit capped at 455 (13.5)"); assert.match(credit.notes[0]!, /699 actual days capped at 455/);
  assert.equal(creditDelays([{ category: "military_indulgence", from: D("2026-04-01"), to: D("2028-02-29"), reported_timely: true }, { category: "military_indulgence", from: D("2028-03-01"), to: D("2028-06-01"), reported_timely: true }]).credited_days, 455, "a second indulgence period earns no additional credit (first occurrence)");
  assert.match(scraCaseClose({ service_end_on: D("2027-02-28"), evidence: {} }).refusal!, /needs evidence/);
});
test("13.8-T5: Given a judicial case with a proposed default-judgment motion, Then the affidavit gate requires a `signing_officer`-executed affidavit on certificates ≤30 days; motion instruction released only after filing evidence.", async () => {
  const stale = affidavitGate({ judicial: true, certificate_on: D("2026-08-01"), today: D("2026-09-15"), executed_by_role: "signing_officer", filing_evidence_document_id: "f-1" }); assert.equal(stale.affidavit_valid, false); assert.match(stale.refusal!, /older than 30 days/);
  const unsigned = affidavitGate({ judicial: true, certificate_on: D("2026-09-01"), today: D("2026-09-15"), executed_by_role: "ops_analyst" }); assert.equal(unsigned.affidavit_valid, false);
  const held = affidavitGate({ judicial: true, certificate_on: D("2026-09-01"), today: D("2026-09-15"), executed_by_role: "signing_officer" }); assert.equal(held.affidavit_valid, true); assert.equal(held.motion_instruction_released, false);
  assert.equal(affidavitGate({ judicial: true, certificate_on: D("2026-09-01"), today: D("2026-09-15"), executed_by_role: "signing_officer", filing_evidence_document_id: "f-1" }).motion_instruction_released, true);
  // on the bus: the firm's proposed default-judgment motion (an inbound attorney-network record through dmdc.batch.prepare) arms SCRA_3931_AFFIDAVIT_GATE only when judicial;
  // only a signing_officer executes, only on certificates ≤30 days; execution alone leaves the gate armed — the firm's filing evidence (scra.affidavit.filed) satisfies it and releases the motion instruction
  const b = bus("2026-09-15T12:00:00.000Z");
  const prep = await b.run<{ milestones: { event: string; purpose: string; affidavit_required: boolean }[] }>("13.8", "dmdc.batch.prepare", AGENT, { loan_id: LOAN, records: [{ kind: "dispositive_motion_proposal", loan_id: LOAN, firm_id: "firm-1", judicial: true, motion_kind: "default_judgment", court: "Kings County Supreme Court", received_on: "2026-09-15" }] });
  assert.deepEqual(prep.milestones.map((m) => [m.event, m.purpose, m.affidavit_required]), [["firm.dispositive_motion.proposed", "judgment", true]]);
  assert.equal(b.armed("SCRA_3931_AFFIDAVIT_GATE", undefined).note, "evaluator:13.8.affidavitOnFreshCertificates");
  await b.run("13.8", "dmdc.batch.prepare", AGENT, { loan_id: LOAN, records: [{ kind: "dispositive_motion_proposal", loan_id: "L-nonjudicial", firm_id: "firm-1", judicial: false, motion_kind: "default_judgment", received_on: "2026-09-15" }] });
  assert.equal(b.timers.byCode("SCRA_3931_AFFIDAVIT_GATE").length, 1, "a non-judicial proposal arms no §3931 gate");
  const checklist = { certificate_ids: ["CERT-1"], certificate_on: "2026-09-01", party_match: true };
  await assert.rejects(b.run("13.8", "scra.case.get/open/close", ANALYST, { loan_id: LOAN, op: "affidavit", affidavit_id: "aff-1", checklist }), refused("AFFIDAVIT_SIGNING_OFFICER"), "only a signing_officer executes");
  await assert.rejects(b.run("13.8", "scra.case.get/open/close", SIGNER, { loan_id: LOAN, op: "affidavit", affidavit_id: "aff-1", checklist: { ...checklist, certificate_on: "2026-08-01" } }), /older than 30 days/, "45-day-old certificate");
  const executed = await b.run<{ motion_instruction_released: boolean; records_review: { passed: boolean } }>("13.8", "scra.case.get/open/close", SIGNER, { loan_id: LOAN, op: "affidavit", affidavit_id: "aff-1", checklist });
  assert.equal(executed.records_review.passed, true); assert.equal(executed.motion_instruction_released, false, "executed, not yet filed");
  assert.ok(b.types().includes("scra.affidavit.executed")); assert.equal(b.armed("SCRA_3931_AFFIDAVIT_GATE", undefined).status, "armed", "execution alone does not satisfy the gate");
  const filed = await b.run<{ motion_instruction_released: boolean; gate: string }>("13.8", "scra.case.get/open/close", AGENT, { loan_id: LOAN, op: "affidavit_filed", affidavit_id: "aff-1", filed_at: "2026-09-16T15:00:00.000Z", filed_by_firm_id: "firm-1", document_id: "filing-1" }, "2026-09-16T15:30:00.000Z");
  assert.equal(filed.motion_instruction_released, true); assert.equal(filed.gate, "SCRA_3931_AFFIDAVIT_GATE");
  b.satisfied("SCRA_3931_AFFIDAVIT_GATE", "scra.affidavit.filed");
});
test("13.8-T6: Given a sale scheduled Nov. 3 and a −7-day check returning Y, Then certification withheld/postponement instructed and `scra.violation.suspected` is not raised (prevented).", async () => {
  const r = certificationDmdcCheck({ sale_on: D("2026-11-03"), check_on: D("2026-10-27"), active_duty: true });
  assert.equal(r.certification, "withheld"); assert.equal(r.instruction, "POSTPONE_SALE"); assert.equal(r.violation_suspected, false);
  // on the bus: foreclosure.sale.scheduled{sale_at=2026-11-03} (the 13.x/15.x sale record) arms the −30 and −7 checks; the −7 import returning Y (dmdc.results.import{purpose=presale_7})
  // satisfies SM_DMDC_VERIFY_PRESALE_7 and the Y on file withholds certification: CERTIFY_SALE is refused by the protection gate, POSTPONE_SALE goes to the firm, nothing suspects a violation
  const b = bus("2026-10-01T12:00:00.000Z");
  b.events.append({ type: "foreclosure.sale.scheduled", loanId: LOAN, actor: AGENT, payload: { sale_at: "2026-11-03", scheduled_sale_date: "2026-11-03" } });
  b.armed("SM_DMDC_VERIFY_PRESALE_30", "2026-10-04"); b.armed("SM_DMDC_VERIFY_PRESALE_7", "2026-10-27");
  const imported = await b.run<{ status: string; purpose: string }>("13.8", "dmdc.results.import", AGENT, { loan_id: LOAN, purpose: "presale_7", batch_id: "dmdc-2026-10-27", results: [{ borrower_id: "b1", status: "Y", certificate_id: "CERT-Y-1027", as_of: "2026-10-27", service_begin_on: "2026-03-15" }] }, "2026-10-27T12:00:00.000Z");
  assert.equal(imported.status, "Y"); assert.equal(imported.purpose, "presale_7");
  b.satisfied("SM_DMDC_VERIFY_PRESALE_7", "dmdc.verification.completed"); assert.equal(b.armed("SM_DMDC_VERIFY_PRESALE_30", "2026-10-04").status, "armed", "a presale_7 import does not satisfy the −30 check");
  await assert.rejects(b.run("13.2", "attorney.instruction.send", AGENT, { loan_id: LOAN, kind: "CERTIFY_SALE" }, "2026-10-27T13:00:00.000Z"), gateClosed("SCRA_3953C_FC_PROTECTION_GATE"), "certification withheld");
  await b.run("13.2", "attorney.instruction.send", AGENT, { loan_id: LOAN, kind: "POSTPONE_SALE", sale_on: "2026-11-03" }, "2026-10-27T13:00:00.000Z");
  assert.ok(b.events.all().some((e) => e.type === "attorney.instruction.sent" && e.payload.kind === "POSTPONE_SALE"), "postponement instructed");
  assert.ok(!b.types().includes("foreclosure.sale.certified") && !b.types().includes("scra.violation.suspected"), "prevented — nothing to suspect");
});
test("13.8-T7: Given a DMDC outage the week of the sale, Then postponement instructed rather than proceeding.", () => {
  const r = dmdcOutageBeforeSale({ sale_on: D("2026-11-03"), today: D("2026-10-30"), dmdc_available: false, last_certificate_on: D("2026-10-04") });
  assert.equal(r.instruction, "POSTPONE_SALE"); assert.match(r.reason, /postpone rather than proceed/);
  assert.equal(dmdcOutageBeforeSale({ sale_on: D("2026-11-03"), today: D("2026-10-30"), dmdc_available: false, last_certificate_on: D("2026-10-28") }).instruction, "CERTIFY_SALE");
});
test('13.8-T8: Given a Z result, Then retry with alternate name/DOB; unresolved ⇒ `attorney` decision on an "unable to determine" affidavit; no (A) affidavit generated.', () => {
  const first = zResult({ attempts: [{ name_variant: "legal", dob_variant: "file", status: "Z" }] }); assert.equal(first.retry_required, true); assert.equal(first.affidavit_kind, null);
  const unresolved = zResult({ attempts: [{ name_variant: "legal", dob_variant: "file", status: "Z" }, { name_variant: "alternate", dob_variant: "alternate", status: "Z" }] });
  assert.equal(unresolved.escalation!.kind, "attorney"); assert.equal(unresolved.affidavit_kind, "unable_to_determine"); assert.notEqual(unresolved.affidavit_kind, "A_not_in_service");
  assert.equal(zResult({ attempts: [{ name_variant: "legal", dob_variant: "file", status: "Z" }, { name_variant: "alternate", dob_variant: "file", status: "N" }] }).affidavit_kind, "A_not_in_service");
});
test("13.8-T9: Given a sale held in violation, Then rescission escalation to `attorney` and `officer` same day; 13.5 rescission-fee exposure booked.", () => {
  const r = saleInViolation({ sale_on: D("2026-11-03"), discovered_on: D("2026-11-04"), third_party_costs_cents: 62_500n });
  assert.deepEqual(r.escalations.map((e) => [e.kind, e.severity]), [["attorney", "sev1"], ["officer", "sev1"]]); assert.equal(r.due, "2026-11-04"); assert.equal(r.exposure_cents, 162_500n); assert.equal(r.root_cause, "servicer:scra");
});
test("13.8-T10: Given a borrower asks to waive SCRA protection so the sale can proceed, Then the agent declines to solicit/accept and routes to `attorney` (Fannie Mae forbids seeking consent).", () => {
  const r = waiverRequest({ borrower_asks_to_waive: true }); assert.equal(r.solicited, false); assert.equal(r.accepted, false); assert.equal(r.escalation!.kind, "attorney"); assert.match(r.escalation!.reason, /forbids seeking consent/);
});
test("13.8-T11: **(leap-crossing fixture — regression guard on the tail arithmetic)** Given `service_end_on` = **2027-06-01**, so the tail window contains **Feb 29, 2028** (366 actual days), Then `protection_ends_on` = **2028-06-01** (`SCRA_3953_TAIL_1Y`, a calendar-year addition); `SCRA_3953C_FC_PROTECTION_GATE` **must still be closed on 2028-05-31** — the date a `+365 calendar_days` offset would have opened — and on 2028-06-01, and opens only on **2028-06-02**. A build that permits `foreclosure.refer`, `first_notice`, `judgment_motion`, `sale_schedule`, `sale_conduct` or `eviction` on 2028-05-31 or 2028-06-01 fails this test (invalid sale under §3953(c); §3953(d) exposure).", async () => {
  const tail = protectionTail(D("2027-06-01")); assert.equal(tail.protection_ends_on, "2028-06-01"); assert.equal(tail.gate_opens_on, "2028-06-02"); assert.equal(protectionEndsOn(D("2027-06-01")), "2028-06-01");
  assert.equal(daysBetween(D("2027-06-01"), D("2028-06-01")), 366, "the window contains Feb 29, 2028"); assert.equal(addDays(D("2027-06-01"), 365), "2028-05-31", "the date a +365 calendar_days offset would have opened");
  for (const on of [D("2028-05-31"), D("2028-06-01")]) { assert.equal(fcGateClosed(on, D("2027-06-01"), false), true, `closed on ${on}`); }
  assert.equal(fcGateClosed(D("2028-06-02"), D("2027-06-01"), false), false, "opens only on 2028-06-02");
  const steps = ["refer", "first_notice", "judgment_motion", "sale_schedule", "sale_conduct", "eviction"] as const;
  for (const step of steps) for (const on of [D("2028-05-31"), D("2028-06-01")]) assert.equal(fcGateClosed(on, D("2027-06-01"), false) ? "refused" : "allowed", "refused", `${step} on ${on}`);
  assert.equal(scraCaseClose({ service_end_on: D("2027-06-01"), evidence: { dmdc_certificate_id: "cert-left-active-duty" } }).protection_ends_on, "2028-06-01");
  // on the bus: scra.period.started arms SCRA_3953C_FC_PROTECTION_GATE (evaluator-asserted); scra.period.ended{ended_on=2027-06-01} arms SCRA_3953_TAIL_1Y due 2028-06-01 — a calendar year,
  // not the 2028-05-31 a +365-day offset gives; every spec step is refused on 2028-05-31 and 2028-06-01; the engine's sweep on 2028-06-02 closes the case and its gate-opened event satisfies the tail timer
  const b = bus("2026-06-03T12:00:00.000Z");
  b.put("loans", LOAN, { loan_id: LOAN, state: "NY", earliest_unpaid_due: "2026-04-01", occupancy: "unknown" });
  await b.run("13.8", "scra.case.get/open/close", AGENT, { loan_id: LOAN, op: "open", dmdc_status: "Y", origination_on: "2024-03-01", service_begin_on: "2026-03-15", verified_on: "2026-06-03" });
  assert.equal(b.armed("SCRA_3953C_FC_PROTECTION_GATE", undefined).note, "evaluator:13.8.protectionGateOpen"); b.armed("FNMA_D23401_SM_CONTACT_90", "2026-09-01");
  await b.run("13.8", "scra.case.get/open/close", AGENT, { loan_id: LOAN, op: "close", service_end_on: "2027-06-01", dmdc_certificate_id: "cert-left-active-duty" }, "2027-06-05T12:00:00.000Z");
  const tailTimer = b.armed("SCRA_3953_TAIL_1Y", "2028-06-01"); assert.equal(tailTimer.anchorDate, "2027-06-01"); assert.notEqual(tailTimer.dueDate, addDays(D("2027-06-01"), 365), "not a +365 calendar_days offset");
  assert.ok(!b.timers.evaluate("2028-06-01T23:00:00.000Z").some((x) => x.instance.code === "SCRA_3953_TAIL_1Y"), "the window is inclusive through 2028-06-01 (19:00 ET)");
  for (const on of ["2028-05-31", "2028-06-01"]) {
    for (const step of steps) { const g = await b.run<{ blocked_by: string[]; gates: { gate_code: string; result: string }[] }>("13.1", "foreclosure.gates.evaluate", AGENT, { loan_id: LOAN, step }, `${on}T12:00:00.000Z`); assert.equal(g.gates.find((x) => x.gate_code === "SCRA_3953C_FC_PROTECTION_GATE")!.result, "closed", `${step} on ${on}`); assert.ok(g.blocked_by.includes("SCRA_3953C_FC_PROTECTION_GATE"), `${step} blocked on ${on}`); }
    await assert.rejects(b.run("13.2", "attorney.instruction.send", AGENT, { loan_id: LOAN, kind: "CERTIFY_SALE" }, `${on}T12:00:00.000Z`), gateClosed("SCRA_3953C_FC_PROTECTION_GATE"), `sale certification refused on ${on}`);
  }
  assert.ok(!b.types().includes("scra.case.closed"), "no closure while the tail runs"); assert.equal(tailTimer.status, "armed");
  const after = await b.run<{ gates: { gate_code: string; result: string }[] }>("13.1", "foreclosure.gates.evaluate", AGENT, { loan_id: LOAN, step: "refer" }, "2028-06-02T12:00:00.000Z");
  assert.equal(after.gates.find((x) => x.gate_code === "SCRA_3953C_FC_PROTECTION_GATE")!.result, "open", "opens only on 2028-06-02");
  const closedEvent = b.events.all().find((e) => e.type === "scra.case.closed")!; assert.equal(closedEvent.payload.reason, "tail_expired"); assert.equal(closedEvent.payload.protection_ends_on, "2028-06-01"); assert.equal(closedEvent.payload.gate_opens_on, "2028-06-02");
  assert.equal(b.satisfied("SCRA_3953_TAIL_1Y", "foreclosure.gate.opened").id, tailTimer.id); assert.equal(b.rt.store.get("scra_cases", `scra-${LOAN}`)!.data.status, "closed");
  await b.run("13.2", "attorney.instruction.send", AGENT, { loan_id: LOAN, kind: "CERTIFY_SALE" }, "2028-06-02T12:00:00.000Z");
});
test("13.8-T12: **(Feb 29 clamp)** Given `service_end_on` = **2028-02-29**, Then `protection_ends_on` = **2029-02-28** (the target date does not exist in the following year; the addition clamps to the last day of the month) and the gate opens **2029-03-01**; no exception is thrown and no null date is written.", () => {
  const r = protectionTail(D("2028-02-29"));
  assert.equal(r.protection_ends_on, "2029-02-28"); assert.equal(r.gate_opens_on, "2029-03-01"); assert.equal(protectionEndsOn(D("2028-02-29")), "2029-02-28");
  assert.equal(fcGateClosed(D("2029-02-28"), D("2028-02-29"), false), true); assert.equal(fcGateClosed(D("2029-03-01"), D("2028-02-29"), false), false);
});
