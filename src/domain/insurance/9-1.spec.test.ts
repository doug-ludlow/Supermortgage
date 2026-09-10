// 9.1 Hazard insurance tracking
// spec/sections/09-insurance-property-protection/9-1-hazard-insurance-tracking.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import { evaluateAdequacy, verifyPolicy, renewalShortcut, coverageDecreaseFollowUp, confirmationRequired, lapseDetectedOn, annualReminderDue, annualReminderNextDue, ANNUAL_REMINDER_MANDATORY_FROM, masterPolicyDeficiencies, mortgageeChangeRequest, deficiencyNoticeDue, vendorFeedSeverity, UNIT_DEDUCTIBLE_FLOOR, type HazardPolicy } from "./hazard.ts";
import { lpiPlacementRequest, lapseDetected } from "./ops.ts";
import { HazardTracking, RULE_SET_9_1, INSURANCE_AGENT, type TrackedLoan, type ExtractionConfidence } from "./ops-9-1.ts";
import { MemoryEventStore, FixedClock, SYSTEM, type DomainEvent, type Actor } from "../../kernel/events/index.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { NoticeService } from "../../notices/service.ts";
import { buildRegistry } from "../../notices/catalog.ts";
import { publishCheck } from "../../notices/checklist.ts";
import { SECTION_09_VERSIONS } from "../../notices/authored/section09.ts";
import type { NoticeRegistry } from "../../notices/registry.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { FakeLpiTracking, type PolicyMessage } from "../../infra/integrations/property.ts";
import { EscalationService } from "../../app/escalations.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { CommandBus } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { SECTION_09_TOOLS } from "../../app/tools/section09.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";

const GOOD: HazardPolicy = {
  coverage_dwelling_cents: 25000000n, coverage_basis: "replacement_cost", coverage_form: "special", deductible_cents: 800000n,
  per_peril_deductibles: [], ratings: [{ agency: "am_best", grade: "A" }],
  mortgagee_clause: { names_partner_isaoa: true, co_servicer: true, names_mers: false }, named_insureds: ["Jane Doe"], excludes_wind: false,
};
const LOAN = "L-91";
const BORROWER = [{ partyId: "B1", name: "Jane Doe", mailingAddress: "1 Test St, Testville TX 75001" }];
const FULL_CONF: ExtractionConfidence = { policy_number: 0.99, effective_date: 0.99, expiration_date: 0.99, coverage_amount: 0.98, deductible: 0.97, mortgagee_clause: 0.95, property_address: 0.99 };
/** Servicer contact block every 9.1 notice carries (the authored §9 sample's constants). */
const SERVICER = { servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001", insurance_email: "insurance@example.com", account_last4: "1234", property_address: "1 Test St, Testville TX 75001", fnma_consumer_url: "knowyouroptions.com/insurance", carrier_name: "Test Mutual", policy_number: "HO-4471" };
const loanFacts = (over: Partial<TrackedLoan> = {}): TrackedLoan => ({ loan_id: LOAN, vendor_loan_id: "V-91", boarded_on: D("2026-03-01"), escrowed: false, regx_days_delinquent: 0, title_holders: ["Jane Doe"], recipients: BORROWER, last_reminder_sent_on: null, ...over });

/** Counsel approval of the §9 authored versions only, so this file does not depend on other sections' templates. */
const publish9 = (reg: NoticeRegistry): NoticeRegistry => { for (const v of SECTION_09_VERSIONS) reg.publish(v.templateCode, v.version, "counsel", "2026-09-01T00:00:00.000Z", publishCheck); return reg; };
/** The 9.1 tracker over an in-memory event store whose TimerEngine runs the overridden registry for 9.1 (and 9.2, for the (k)(5) gate). */
function rig(iso: string, opts: { processes?: readonly string[]; annual_reminder_enabled?: boolean } = {}) {
  const clock = new FixedClock(iso); const events = new MemoryEventStore(clock);
  const engine = new TimerEngine(loadOverriddenRegistry(), events, { processes: [...(opts.processes ?? ["9.1", "9.2"])] });
  const registry = publish9(buildRegistry());
  const notices = new NoticeService({ registry, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const escalations = new EscalationService(events, clock);
  const svc = new HazardTracking({ events, clock, notices, escalations, notice_defaults: SERVICER, ...(opts.annual_reminder_enabled !== undefined ? { annual_reminder_enabled: opts.annual_reminder_enabled } : {}) });
  const sample = (code: string): Record<string, unknown> => ({ ...registry.activeVersion(code, D(clock.now().slice(0, 10)))!.samplePayload });
  const timers = (code: string) => engine.byCode(code).filter((t) => t.loanId === LOAN);
  const latest = (code: string) => { const l = timers(code); assert.ok(l.length, `no ${code} instance on ${LOAN}`); return l[l.length - 1]!; };
  const types = (from: number): string[] => events.since(from).map((e) => e.type);
  const raise = (type: string, payload: Record<string, unknown> = {}, actor: Actor = SYSTEM): DomainEvent => events.append({ type, loanId: LOAN, actor, payload });
  return { clock, events, engine, registry, notices, escalations, svc, sample, timers, latest, types, raise };
}
type Rig = ReturnType<typeof rig>;
/** Board the loan, receive a policy from the boarding file, confirm its dec page and run adequacy (T1 path). */
function verifiedPolicy(r: Rig, o: { policy_id?: string; effective?: string; expiration?: string; policy?: HazardPolicy; loan?: Partial<TrackedLoan> } = {}) {
  const id = o.policy_id ?? "HO-4471"; const policy = o.policy ?? GOOD;
  if (!r.svc.loans.has(LOAN)) r.svc.boardLoan(loanFacts(o.loan ?? {}));
  r.svc.receivePolicy({ policy_id: id, loan_id: LOAN, effective_date: D(o.effective ?? "2026-05-01"), expiration_date: D(o.expiration ?? "2027-04-30"), coverage_dwelling_cents: policy.coverage_dwelling_cents, source: "boarding" });
  r.svc.receiveEvidence({ evidence_id: `ev-${id}`, loan_id: LOAN, policy_id: id, channel: "eoi_document", document_sha256: `sha256:${id}`, extraction: { confidence: FULL_CONF } });
  r.svc.confirmEvidence({ evidence_id: `ev-${id}`, confirmed_via: "vendor" });
  return r.svc.evaluatePolicy({ policy_id: id, loan_id: LOAN, evidence_id: `ev-${id}`, policy });
}
const def = (code: string) => loadOverriddenRegistry().get(code)!;

test("9.1-T1: Given a boarded loan with a dec page (Special form, RC basis, $8,000 deductible on $250,000, AM Best A) When ingested Then policy `verified`, adequacy PASS, `last_known_coverage_cents=25000000`.", () => {
  const v = verifyPolicy(GOOD, ["Jane Doe"], true);
  assert.equal(v.status, "verified"); assert.equal(v.adequacy.pass, true); assert.deepEqual(v.adequacy.deficiencies, []); assert.equal(v.adequacy.deductible_pct.slice(0, 8), "0.032000");
  assert.equal(v.last_known_coverage_cents, 25000000n);
  assert.equal(verifyPolicy(GOOD, ["Jane Doe"], false).status, "pending_verification");   // guardrail: never `verified` without a confirmed evidence record
  // ingest → extract → confirm → adequacy through the tracker: the dec page verifies the policy and the row arms the annual and −60 clocks
  const r = rig("2026-09-10T14:00:00.000Z"); const from = r.events.lastSequence();
  const res = verifiedPolicy(r);
  assert.equal(res.status, "verified"); assert.equal(res.adequacy!.pass, true); assert.equal(res.decision.outcome, "verified"); assert.equal(res.decision.rule_set, RULE_SET_9_1); assert.equal(res.decision.evidence_hash, "sha256:HO-4471");
  const pol = r.svc.policies.get("HO-4471")!;
  assert.equal(pol.status, "verified"); assert.equal(pol.last_known_coverage_cents, 25000000n); assert.equal(pol.verified_at, "2026-09-10"); assert.equal(pol.version, 2);   // received (v1) → verified (v2): append-only history
  assert.deepEqual(r.types(from).filter((t) => t.startsWith("insurance.")), ["insurance.policy.received", "insurance.evidence.received", "insurance.evidence.confirmed", "insurance.policy.verified"]);
  const verified = r.events.ofType("insurance.policy.verified")[0]!;
  assert.equal(verified.payload.verified_at, "2026-09-10"); assert.equal(verified.payload.expiration_date, "2027-04-30"); assert.equal(verified.payload.term, "initial"); assert.equal(verified.payload.last_known_coverage_cents, 25000000n);
  assert.ok(eventMatches(def("FNMA_B202_POLICY_ANNUAL_VERIFY_365").triggerPattern!, verified)); assert.ok(eventMatches(def("INS_EXPIRATION_WATCH_60").triggerPattern!, verified));
  assert.equal(r.latest("FNMA_B202_POLICY_ANNUAL_VERIFY_365").dueDate, "2027-09-10");   // verified_at + 365 calendar days (B-2-02 "at a minimum annually")
  assert.equal(r.latest("INS_EXPIRATION_WATCH_60").dueDate, "2027-03-01");             // expiration_date 2027-04-30 − 60 calendar days
  assert.equal(r.timers("INS_EXPIRATION_LAPSE_1").length, 0);
});
test("9.1-T2: Given a renewal with $12,501 deductible on $250,000 When evaluated Then FAIL `deductible_excess`, `INS_DEFICIENCY_NOTICE` sent within 5 servicer business days.", async () => {
  assert.equal(evaluateAdequacy({ ...GOOD, deductible_cents: 1250000n }, ["Jane Doe"]).pass, true);   // exactly 5.0000% → PASS (compared without rounding)
  const r0 = evaluateAdequacy({ ...GOOD, deductible_cents: 1250100n }, ["Jane Doe"]);
  assert.equal(r0.pass, false); assert.deepEqual(r0.deficiencies, ["deductible_excess"]); assert.equal(r0.lpi_curable, false);   // not an LPI trigger (9.2 rule 1)
  assert.equal(verifyPolicy({ ...GOOD, deductible_cents: 1250100n }, ["Jane Doe"], true).status, "deficient");
  assert.equal(deficiencyNoticeDue(D("2027-04-30")), "2027-05-07");   // Fri + 5 servicer business days (FNMA_B202_INSUFFICIENCY_NOTICE_5BD)
  // the tracker: FAIL → insurance_deficiencies row + insurance.deficiency.detected arms the 5-BD row; the INS_DEFICIENCY_NOTICE through the Notice Registry closes it
  const r = rig("2027-04-30T14:00:00.000Z");
  const res = verifiedPolicy(r, { policy: { ...GOOD, deductible_cents: 1250100n } });
  assert.equal(res.status, "deficient"); assert.deepEqual(res.deficiencies, ["deductible_excess"]); assert.equal(res.notice_due, "2027-05-07"); assert.equal(res.event!.type, "insurance.deficiency.detected"); assert.equal(res.event!.payload.detected_at, "2027-04-30T14:00:00.000Z");
  assert.equal(r.svc.policies.get("HO-4471")!.status, "deficient"); assert.equal(r.svc.deficiencies.get(res.deficiency_id!)!.status, "open");
  const sla = r.latest("FNMA_B202_INSUFFICIENCY_NOTICE_5BD"); assert.equal(sla.status, "armed"); assert.equal(sla.dueDate, "2027-05-07"); assert.equal(sla.anchorDate, "2027-04-30");
  r.clock.set("2027-05-04T14:00:00.000Z");
  const sent = await r.svc.sendDeficiencyNotice({ deficiency_id: res.deficiency_id!, payload: r.sample("INS_DEFICIENCY_NOTICE") });
  assert.equal(sent.sent, true); assert.equal(sent.template, "INS_DEFICIENCY_NOTICE"); assert.equal(sent.sent_on, "2027-05-04"); assert.equal(sent.on_time, true);
  const noticeSent = r.events.ofType("notice.sent").find((e) => e.payload.template === "INS_DEFICIENCY_NOTICE")!; assert.ok(noticeSent, "the Notice Registry emitted notice.sent for the deficiency notice");
  assert.equal(sla.status, "satisfied"); assert.equal(sla.satisfiedByEventId, noticeSent.id);
  assert.equal(r.svc.deficiencies.get(res.deficiency_id!)!.status, "notified"); assert.equal(r.events.ofType("insurance.deficiency.notified").length, 1);
});
test("9.1-T3: Given a renewal certificate silent on basis and coverage down from $300,000 to $280,000 When evaluated Then `coverage_decrease_unconfirmed`, agent confirmation task, documented steps in the decision record.", () => {
  const r0 = renewalShortcut(28000000n, 30000000n, false);
  assert.equal(r0, "coverage_decrease_unconfirmed");
  const task = coverageDecreaseFollowUp(r0)!;
  assert.equal(task.task, "carrier_confirmation"); assert.equal(task.documented_in, "decision_record"); assert.ok(task.steps.length >= 2 && task.steps.some((s) => /confirmation call/.test(s)));
  assert.equal(renewalShortcut(31200000n, 30000000n, false), "verified"); assert.equal(coverageDecreaseFollowUp("verified"), null);   // unchanged/increased → verified with a note
  assert.equal(renewalShortcut(28000000n, null, false), "coverage_decrease_unconfirmed");   // prior amount unknown → additional steps
  // the tracker: last year's verified $300,000 term, then a renewal certificate at $280,000 silent on the loss-settlement basis
  const r = rig("2026-05-01T14:00:00.000Z");
  assert.equal(verifiedPolicy(r, { policy: { ...GOOD, coverage_dwelling_cents: 30000000n } }).status, "verified"); assert.equal(r.svc.policies.get("HO-4471")!.last_known_coverage_cents, 30000000n);
  r.clock.set("2027-04-01T14:00:00.000Z");
  const ev = r.svc.receiveEvidence({ evidence_id: "ev-renewal", loan_id: LOAN, policy_id: "HO-4471", channel: "mail", document_sha256: "sha256:cert", extraction: { confidence: FULL_CONF } });
  assert.equal(ev.kind, "renewal"); r.svc.confirmEvidence({ evidence_id: "ev-renewal", confirmed_via: "agent_call" });
  const res = r.svc.evaluatePolicy({ policy_id: "HO-4471", loan_id: LOAN, evidence_id: "ev-renewal", policy: { ...GOOD, coverage_dwelling_cents: 28000000n }, basis_stated: false, effective_date: D("2027-04-30"), expiration_date: D("2028-04-30") });
  assert.equal(res.status, "deficient"); assert.deepEqual(res.deficiencies, ["coverage_decrease_unconfirmed"]); assert.equal(res.task!.task, "carrier_confirmation");
  assert.deepEqual(res.decision.last_known_comparison, { coverage_cents: 28000000n, last_known_cents: 30000000n, result: "coverage_decrease_unconfirmed" });
  assert.ok(res.decision.steps.length >= 2 && res.decision.steps.some((s) => /confirmation call/.test(s)) && res.decision.steps.some((s) => /policy jacket|replacement-cost endorsement/.test(s)), "additional steps documented in the decision record");
  assert.equal(res.decision.outcome, "coverage_decrease_unconfirmed"); assert.ok(r.svc.decisions.some((d) => d.decision_id === res.decision.decision_id));
  assert.deepEqual(res.event!.payload.additional_steps, [...res.decision.steps]); assert.equal(res.event!.payload.task, "carrier_confirmation");
  assert.equal(r.svc.policies.get("HO-4471")!.last_known_coverage_cents, 30000000n, "the last known amount is not overwritten until the term verifies");
  // the RC endorsement page arrives (basis stated) → cured and verified for the new term
  r.svc.receiveEvidence({ evidence_id: "ev-rc", loan_id: LOAN, policy_id: "HO-4471", channel: "agent_call", extraction: { confidence: FULL_CONF } }); r.svc.confirmEvidence({ evidence_id: "ev-rc", confirmed_via: "agent_call" });
  const cured = r.svc.evaluatePolicy({ policy_id: "HO-4471", loan_id: LOAN, evidence_id: "ev-rc", policy: { ...GOOD, coverage_dwelling_cents: 28000000n }, basis_stated: true });
  assert.equal(cured.status, "verified"); assert.equal(cured.event!.payload.term, "renewal"); assert.equal(r.svc.policies.get("HO-4471")!.last_known_coverage_cents, 28000000n);
  assert.equal(r.svc.cureDeficiency({ deficiency_id: res.deficiency_id!, resolution: "evidence_received" }).status, "cured");
});
test("9.1-T4: Given extraction confidence 0.82 on policy number When processed Then carrier confirmation required before `verified`.", () => {
  const conf = { policy_number: 0.82, effective_date: 0.99, expiration_date: 0.99, coverage_amount: 0.95, deductible: 0.95, mortgagee_clause: 0.95, property_address: 0.95 };
  assert.deepEqual(confirmationRequired(conf), ["policy_number"]);
  assert.deepEqual(confirmationRequired({ ...conf, policy_number: 0.9 }), []);
  assert.equal(verifyPolicy(GOOD, ["Jane Doe"], false).status, "pending_verification");   // unconfirmed evidence never verifies
  assert.equal(verifyPolicy(GOOD, ["Jane Doe"], true).status, "verified");
  // the tracker: the evidence record waits for the carrier; adequacy PASS alone never emits insurance.policy.verified
  const r = rig("2026-09-10T14:00:00.000Z"); r.svc.boardLoan(loanFacts());
  r.svc.receivePolicy({ policy_id: "HO-4471", loan_id: LOAN, effective_date: D("2026-05-01"), expiration_date: D("2027-04-30"), coverage_dwelling_cents: 25000000n, source: "borrower_portal" });
  const ev = r.svc.receiveEvidence({ evidence_id: "ev-1", loan_id: LOAN, policy_id: "HO-4471", channel: "borrower_portal", extraction: { confidence: conf } });
  assert.equal(ev.verification_status, "needs_carrier_confirmation"); assert.deepEqual(ev.confirmation_required, ["policy_number"]);
  const pending = r.svc.evaluatePolicy({ policy_id: "HO-4471", loan_id: LOAN, evidence_id: "ev-1", policy: GOOD });
  assert.equal(pending.status, "pending_verification"); assert.equal(pending.adequacy!.pass, true); assert.equal(pending.event, null); assert.match(pending.decision.rationale, /cannot mark the policy verified/);
  assert.deepEqual(pending.decision.steps, ["carrier/agent confirmation of policy_number (extraction confidence < 0.90)"]);
  assert.equal(r.events.ofType("insurance.policy.verified").length, 0); assert.equal(r.timers("FNMA_B202_POLICY_ANNUAL_VERIFY_365").length, 0);
  assert.equal(r.svc.confirmEvidence({ evidence_id: "ev-1", confirmed_via: "carrier_api" }).verification_status, "confirmed");
  const verified = r.svc.evaluatePolicy({ policy_id: "HO-4471", loan_id: LOAN, evidence_id: "ev-1", policy: GOOD });
  assert.equal(verified.status, "verified"); assert.equal(r.events.ofType("insurance.policy.verified").length, 1); assert.equal(r.latest("FNMA_B202_POLICY_ANNUAL_VERIFY_365").dueDate, "2027-09-10");
  // rejection only for the two comment 37(c)(1)(iii)-2 reasons
  r.svc.receiveEvidence({ evidence_id: "ev-2", loan_id: LOAN, policy_id: "HO-4471", channel: "mail", extraction: { confidence: conf } });
  assert.throws(() => r.svc.rejectEvidence({ evidence_id: "ev-2", reject_reason: "illegible" as never }), RangeError);
  assert.equal(r.svc.rejectEvidence({ evidence_id: "ev-2", reject_reason: "not_confirmed_by_carrier_or_agent" }).verification_status, "rejected");
  assert.throws(() => r.svc.confirmEvidence({ evidence_id: "ev-2", confirmed_via: "vendor" }), RangeError);
});
test("9.1-T5: Given a policy expiring 2027-04-30 and no renewal evidence When 2027-05-01 arrives Then `insurance.lapse_detected` emitted and 9.2 opens (escrowed/(k)(5) check applied).", async () => {
  assert.equal(lapseDetectedOn(D("2027-04-30"), false), "2027-05-01"); assert.equal(lapseDetectedOn(D("2027-04-30"), true), null);
  const open = lapseDetected({ escrowed: false, regx_days_delinquent: 0, cancellation_reason: null, insurance_type: "hazard", fdpa_required: false, opened_on: D("2027-05-01") });
  assert.equal(open.case_status, "first_notice_pending"); assert.equal(open.first_notice, "INS_FPI_FIRST_MS3A"); assert.equal(open.k5_gate, "n/a"); assert.equal(open.track, "regx_hazard");
  const k5 = lapseDetected({ escrowed: true, regx_days_delinquent: 45, cancellation_reason: "nonpayment", insurance_type: "hazard", fdpa_required: false, opened_on: D("2027-05-01") });
  assert.equal(k5.case_status, "k5_blocked"); assert.equal(k5.premium, "advanced_by_3_7"); assert.equal(k5.first_notice, null);
  assert.equal(lapseDetected({ escrowed: true, regx_days_delinquent: 10, cancellation_reason: null, insurance_type: "hazard", fdpa_required: false, opened_on: D("2027-05-01") }).case_status, "closed_servicer_pays");
  // the daily sweep on an escrowed loan 45 days overdue whose carrier cancelled for non-payment: −60 expiring, −30 EOI request, expiration passes → INS_EXPIRATION_LAPSE_1, +1 → lapse → 9.2 (k)(5)-blocked
  const r = rig("2026-05-01T14:00:00.000Z");
  assert.equal(verifiedPolicy(r, { expiration: "2027-04-30", loan: { escrowed: true, regx_days_delinquent: 45, cancellation_reason: "nonpayment" } }).status, "verified");
  assert.equal(r.latest("INS_EXPIRATION_WATCH_60").dueDate, "2027-03-01");
  r.clock.set("2027-03-01T14:00:00.000Z"); let s = await r.svc.sweep();
  assert.deepEqual(s.expiring, ["HO-4471"]); assert.deepEqual(s.eoi_requested, []); assert.equal(r.svc.policies.get("HO-4471")!.status, "expiring"); assert.equal(r.events.ofType("insurance.policy.expiring")[0]!.payload.days_to_expiration, 60);
  r.clock.set("2027-03-31T14:00:00.000Z"); s = await r.svc.sweep();
  assert.deepEqual(s.eoi_requested, ["HO-4471"]); assert.equal(r.events.ofType("notice.sent").filter((e) => e.payload.template === "INS_EOI_REQUEST").length, 1, "the −30 courtesy request went through the Notice Registry");
  r.clock.set("2027-04-30T14:00:00.000Z"); s = await r.svc.sweep();
  assert.deepEqual(s.expired, ["HO-4471"]); assert.deepEqual(s.lapses, []); assert.equal(r.svc.policies.get("HO-4471")!.status, "expired");
  const expired = r.events.ofType("insurance.policy.expired")[0]!; assert.equal(expired.payload.evidence_received, false); assert.equal(expired.payload.expiration_date, "2027-04-30");
  assert.ok(eventMatches(def("INS_EXPIRATION_LAPSE_1").triggerPattern!, expired));
  const lapse = r.latest("INS_EXPIRATION_LAPSE_1"); assert.equal(lapse.status, "armed"); assert.equal(lapse.anchorDate, "2027-04-30"); assert.equal(lapse.dueDate, "2027-05-01");   // expiration_date + 1 calendar day
  assert.equal(r.events.ofType("insurance.lapse_detected").length, 0); assert.equal(r.timers("REGX_1024_17K5_LPI_PURCHASE_GATE").length, 0);
  r.clock.set("2027-05-01T14:00:00.000Z"); s = await r.svc.sweep();
  assert.equal(s.lapses.length, 1); assert.equal(s.lapses[0]!.outcome.case_status, "k5_blocked"); assert.equal(s.lapses[0]!.outcome.premium, "advanced_by_3_7"); assert.equal(s.lapses[0]!.case_opened, true);
  const detected = r.events.ofType("insurance.lapse_detected")[0]!; assert.equal(detected.payload.lapse_on, "2027-05-01"); assert.equal(detected.payload.escrowed, true); assert.equal(detected.payload.regx_days_delinquent, 45); assert.equal(detected.payload.k5_gate, "blocked_advance");
  const opened = r.events.ofType("fpi.case.opened")[0]!; assert.equal(opened.payload.escrowed, true); assert.equal(opened.payload.case_status, "k5_blocked"); assert.equal(opened.payload.track, "regx_hazard"); assert.equal(opened.payload.first_notice, null);
  const gate = r.latest("REGX_1024_17K5_LPI_PURCHASE_GATE"); assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:9.2.escrowedAdvanceBeforeForcePlacement");
  assert.equal(evaluateGate("9.2.escrowedAdvanceBeforeForcePlacement", { escrowed: true, regx_days_delinquent: 45, cancellation_reason: "nonpayment" }).open, false);   // LPI command refused; premium advanced
  assert.equal(evaluateGate("9.2.escrowedAdvanceBeforeForcePlacement", { escrowed: true, regx_days_delinquent: 45, cancellation_reason: "underwriting" }).open, true);   // documented inability: cancelled for a reason other than non-payment (comment 17(k)(5)(ii)(A)-1)
  assert.equal((await r.svc.sweep()).lapses.length, 0, "a lapse is detected once");
  assert.equal(r.engine.evaluate("2027-05-02T04:00:00.000Z").map((b) => b.def.code).includes("INS_EXPIRATION_LAPSE_1"), true); assert.equal(lapse.status, "breached");
  // a non-escrowed borrower: the MS-3(A) cycle opens and no (k)(5) gate arms
  const n = rig("2027-04-30T14:00:00.000Z"); assert.equal(verifiedPolicy(n, { expiration: "2027-04-30" }).status, "verified"); await n.svc.sweep();
  n.clock.set("2027-05-01T14:00:00.000Z"); const ns = await n.svc.sweep();
  assert.equal(ns.lapses[0]!.outcome.case_status, "first_notice_pending"); assert.equal(n.events.ofType("fpi.case.opened")[0]!.payload.first_notice, "INS_FPI_FIRST_MS3A"); assert.equal(n.timers("REGX_1024_17K5_LPI_PURCHASE_GATE").length, 0);
});
test("9.1-T6: Given a loan with no reminder in 12 months When the sweep runs Then `INS_ANNUAL_REMINDER` sent and the recurring timer reset; feature flag on before 2027-01-01.", async () => {
  assert.equal(annualReminderDue(D("2026-03-01"), D("2027-03-05")), true);
  assert.equal(annualReminderDue(null, D("2026-12-15")), true);                       // never reminded → due (flag on before the mandatory date)
  assert.equal(annualReminderDue(D("2026-09-01"), D("2027-03-05")), false);
  assert.equal(annualReminderNextDue(D("2027-03-05")), "2028-03-04");                  // FNMA_B201_ANNUAL_INSURANCE_REMINDER_365 re-armed from the send: 365 calendar days (2028 is a leap year)
  assert.equal(ANNUAL_REMINDER_MANDATORY_FROM, "2027-01-01"); assert.ok(D("2026-12-31") < ANNUAL_REMINDER_MANDATORY_FROM);
  // boarding arms the recurring row; the sweep a year later sends INS_ANNUAL_REMINDER through the Notice Registry, whose notice.sent{template} satisfies it and re-arms it from sent_at
  const r = rig("2026-03-01T14:00:00.000Z"); r.svc.boardLoan(loanFacts({ boarded_on: D("2026-03-01") }));
  r.raise("loan.boarded", { escrowed: false });
  const first = r.latest("FNMA_B201_ANNUAL_INSURANCE_REMINDER_365"); assert.equal(first.status, "armed"); assert.equal(first.dueDate, "2027-03-01");   // boarding + 365 calendar days
  r.clock.set("2027-03-05T14:00:00.000Z"); const s = await r.svc.sweep();
  assert.deepEqual(s.reminders_sent, [LOAN]); assert.deepEqual(s.reminders_due, []);
  const sent = r.events.ofType("notice.sent").find((e) => e.payload.template === "INS_ANNUAL_REMINDER")!; assert.ok(sent); assert.equal(sent.payload.sent_at, "2027-03-05T14:00:00.000Z");
  assert.equal(first.status, "satisfied"); assert.equal(first.satisfiedByEventId, sent.id);
  const reset = r.latest("FNMA_B201_ANNUAL_INSURANCE_REMINDER_365"); assert.notEqual(reset.id, first.id); assert.equal(reset.status, "armed"); assert.equal(reset.anchorDate, "2027-03-05"); assert.equal(reset.dueDate, "2028-03-04");
  assert.equal(r.svc.loans.get(LOAN)!.last_reminder_sent_on, "2027-03-05"); assert.equal(r.events.ofType("insurance.reminder.sent")[0]!.payload.next_due, "2028-03-04");
  assert.deepEqual((await r.svc.sweep()).reminders_sent, [], "one per loan per 12 months");
  await assert.rejects(r.svc.sendAnnualReminder({ loan_id: LOAN }), RangeError);
  // feature flag: on by default before 2027-01-01; off → the sweep queues nothing
  const early = rig("2026-12-15T14:00:00.000Z"); early.svc.boardLoan(loanFacts({ boarded_on: D("2025-12-01") })); assert.ok(D("2026-12-15") < ANNUAL_REMINDER_MANDATORY_FROM);
  assert.deepEqual((await early.svc.sweep()).reminders_sent, [LOAN]);
  const off = rig("2026-12-15T14:00:00.000Z", { annual_reminder_enabled: false }); off.svc.boardLoan(loanFacts({ boarded_on: D("2025-12-01") }));
  const os = await off.svc.sweep(); assert.deepEqual(os.reminders_sent, []); assert.deepEqual(os.reminders_due, []); assert.equal(off.events.ofType("notice.sent").length, 0);
});
test("9.1-T7: Given a condo unit whose master shows a $60,000 per-unit deductible When evaluated Then `master_lapse`-class deficiency (per-unit > $50,000) and `unit_policy_missing` if no HO-6.", () => {
  assert.deepEqual(masterPolicyDeficiencies(6000000n, false, true), ["master_lapse", "unit_policy_missing"]);
  assert.deepEqual(masterPolicyDeficiencies(6000000n, true, true), ["master_lapse"]);
  assert.deepEqual(masterPolicyDeficiencies(5000000n, true, true), []);                  // exactly $50,000 is within the B-2-03 cap
  assert.deepEqual(masterPolicyDeficiencies(null, false, false), ["unit_policy_missing"]);   // interior uncovered → HO-6 required (B7-3-04)
  // the tracker: the failing master opens the deficiency (5-BD notice SLA); a compliant master + HO-6 verifies and arms FNMA_B203_MASTER_POLICY_ANNUAL_VERIFY_365
  const r = rig("2026-09-10T14:00:00.000Z"); r.svc.boardLoan(loanFacts());
  const bad = r.svc.verifyMasterPolicy({ project_id: "PRJ-1", loan_id: LOAN, per_unit_deductible_cents: 6000000n, has_unit_policy: false, interior_covered: true });
  assert.equal(bad.status, "deficient"); assert.deepEqual(bad.deficiencies, ["master_lapse", "unit_policy_missing"]); assert.equal(bad.event.type, "insurance.deficiency.detected"); assert.equal(r.latest("FNMA_B202_INSUFFICIENCY_NOTICE_5BD").dueDate, "2026-09-17");
  assert.equal(r.timers("FNMA_B203_MASTER_POLICY_ANNUAL_VERIFY_365").length, 0);
  const ok = r.svc.verifyMasterPolicy({ project_id: "PRJ-1", loan_id: LOAN, per_unit_deductible_cents: 5000000n, has_unit_policy: true, interior_covered: true });
  assert.equal(ok.status, "verified"); assert.equal(ok.verified_at, "2026-09-10"); assert.equal(ok.event.type, "insurance.master_policy.verified"); assert.equal(ok.event.payload.per_unit_deductible_cents, 5000000n);
  const annual = r.latest("FNMA_B203_MASTER_POLICY_ANNUAL_VERIFY_365"); assert.equal(annual.status, "armed"); assert.equal(annual.anchorDate, "2026-09-10"); assert.equal(annual.dueDate, "2027-09-10");
  r.clock.set("2027-09-01T14:00:00.000Z");
  assert.equal(r.svc.verifyMasterPolicy({ project_id: "PRJ-1", loan_id: LOAN, per_unit_deductible_cents: 5000000n, has_unit_policy: true, interior_covered: true }).status, "verified");
  assert.equal(annual.status, "satisfied"); const next = r.latest("FNMA_B203_MASTER_POLICY_ANNUAL_VERIFY_365"); assert.notEqual(next.id, annual.id); assert.equal(next.dueDate, "2028-08-31");   // 2027-09-01 + 365 (2028 is a leap year)
});
test("9.1-T8: Given MERS named as mortgagee When evaluated Then `mortgagee_clause` deficiency and a change-request to the carrier/agent.", () => {
  const p: HazardPolicy = { ...GOOD, mortgagee_clause: { names_partner_isaoa: true, co_servicer: true, names_mers: true } };
  assert.deepEqual(evaluateAdequacy(p, ["Jane Doe"]).deficiencies, ["mortgagee_clause"]);
  const req = mortgageeChangeRequest(p)!;
  assert.equal(req.to, "carrier_or_agent"); assert.equal(req.remove_mers, true); assert.match(req.clause, /successors and\/or assigns, c\/o Supermortgage/);
  assert.equal(mortgageeChangeRequest(GOOD), null);
  // the tracker: the deficiency carries the change request to the carrier/agent and the decision record documents it
  const r = rig("2026-09-10T14:00:00.000Z");
  const res = verifiedPolicy(r, { policy: p });
  assert.equal(res.status, "deficient"); assert.deepEqual(res.deficiencies, ["mortgagee_clause"]); assert.equal(res.change_request!.to, "carrier_or_agent"); assert.equal(res.change_request!.remove_mers, true);
  assert.deepEqual(res.event!.payload.change_request, { to: "carrier_or_agent", clause: req.clause, remove_mers: true }); assert.ok(res.decision.steps.some((s) => /change request to the carrier\/agent/.test(s) && /remove MERS/.test(s)));
  assert.equal(res.adequacy!.lpi_curable, false); assert.equal(r.svc.deficiencies.get(res.deficiency_id!)!.regx_reasonable_basis, false);   // a clause defect is never an LPI basis (9.2 rule 1)
});
test("9.1-T9: Given the vendor feed silent for 3 business days When the sweep runs Then sev-2 escalation; direct-channel intake still works.", async () => {
  assert.equal(vendorFeedSeverity(D("2027-03-01"), D("2027-03-04")), "sev2");
  assert.equal(vendorFeedSeverity(D("2027-03-01"), D("2027-03-03")), "ok");
  assert.equal(verifyPolicy(GOOD, ["Jane Doe"], true).status, "verified");   // an EOI confirmed through a direct channel still verifies
  // the sweep: last vendor message Monday 2027-03-01; Thursday's sweep is three servicer business days later → one sev-2 escalation; a borrower-portal dec page still verifies
  const r = rig("2027-03-03T14:00:00.000Z"); r.svc.boardLoan(loanFacts()); r.svc.recordFeedHeartbeat(D("2027-03-01"));
  assert.equal((await r.svc.sweep()).vendor_feed, "ok"); assert.equal(r.escalations.opened.length, 0);
  r.clock.set("2027-03-04T14:00:00.000Z"); const s = await r.svc.sweep();
  assert.equal(s.vendor_feed, "sev2"); assert.equal(s.escalations.length, 1);
  const esc = r.escalations.opened[0]!; assert.equal(esc.kind, "sev2"); assert.equal(esc.severity, "sev2"); assert.equal(esc.ownerRole, "officer"); assert.match(String(esc.payload.reason), /feed silent for 3 servicer business days/);
  assert.equal(r.events.ofType("escalation.created").length, 1); assert.equal(r.events.ofType("insurance.vendor_feed.stale")[0]!.payload.direct_channel_intake, "continues");
  assert.equal((await r.svc.sweep()).escalations.length, 0, "the stale feed escalates once per gap");
  r.svc.receivePolicy({ policy_id: "HO-4471", loan_id: LOAN, effective_date: D("2027-02-01"), expiration_date: D("2028-02-01"), coverage_dwelling_cents: 25000000n, source: "borrower_portal" });
  r.svc.receiveEvidence({ evidence_id: "ev-portal", loan_id: LOAN, policy_id: "HO-4471", channel: "borrower_portal", extraction: { confidence: FULL_CONF } }); r.svc.confirmEvidence({ evidence_id: "ev-portal", confirmed_via: "borrower_portal_link" });
  assert.equal(r.svc.evaluatePolicy({ policy_id: "HO-4471", loan_id: LOAN, evidence_id: "ev-portal", policy: GOOD }).status, "verified"); assert.equal(r.latest("FNMA_B202_POLICY_ANNUAL_VERIFY_365").dueDate, "2028-03-03");   // 2027-03-04 + 365 (2028 is a leap year)
  r.svc.recordFeedHeartbeat(D("2027-03-05")); r.clock.set("2027-03-05T14:00:00.000Z"); assert.equal((await r.svc.sweep()).vendor_feed, "ok");
});
test("9.1-T10: Given a CA property and an LPI amount above RCV When 9.2 requests placement Then the CA cap rule blocks the amount (jurisdiction override).", () => {
  const r = lpiPlacementRequest({ state: "CA", requested_cents: 30000000n, rcv_cents: 26200000n, upb_cents: 24000000n, last_known_cents: 30000000n, state_cap_cents: null });
  assert.equal(r.blocked, true); assert.match(r.reason!, /CA/); assert.ok(r.allowed_cents <= 26200000n);
  assert.equal(lpiPlacementRequest({ state: "TX", requested_cents: 30000000n, rcv_cents: 26200000n, upb_cents: 24000000n, last_known_cents: 25000000n, state_cap_cents: null }).blocked, false);
});

test("9.1 rule 2: unit-owner policy deductibles are capped at the greater of 5% of coverage and $2,500.00", () => {
  const unit = (coverage: bigint, deductible: bigint) => evaluateAdequacy({ ...GOOD, unit_owner: true, coverage_dwelling_cents: coverage, deductible_cents: deductible }, ["Jane Doe"]);
  assert.equal(UNIT_DEDUCTIBLE_FLOOR, 250000n);
  assert.equal(unit(4000000n, 250000n).pass, true);                                       // $2,500 on $40,000 = 6.25% but ≤ the $2,500 floor → PASS
  assert.deepEqual(unit(4000000n, 250100n).deficiencies, ["deductible_excess"]);          // $2,501 exceeds both 5% ($2,000) and the floor
  assert.equal(unit(10000000n, 500000n).pass, true);                                      // $5,000 on $100,000 = exactly 5% → PASS
  assert.deepEqual(unit(10000000n, 500100n).deficiencies, ["deductible_excess"]);
  assert.deepEqual(evaluateAdequacy({ ...GOOD, coverage_dwelling_cents: 4000000n, deductible_cents: 250000n }, ["Jane Doe"]).deficiencies, ["deductible_excess"]);   // no floor for non-unit policies
});

test("9.1 INS_EXPIRATION_WATCH_60 closes on renewal evidence (insurance.evidence.confirmed{kind=renewal}); INS_EXPIRATION_LAPSE_1 closes on a late insurance.policy.verified, which also re-arms the annual row", async () => {
  // renewal evidence during the −60 window stops the expiration path
  const r = rig("2026-05-01T14:00:00.000Z"); assert.equal(verifiedPolicy(r, { expiration: "2027-04-30" }).status, "verified");
  const watch = r.latest("INS_EXPIRATION_WATCH_60"); assert.equal(watch.status, "armed"); assert.equal(watch.dueDate, "2027-03-01");
  r.clock.set("2027-03-10T14:00:00.000Z"); await r.svc.sweep(); assert.equal(r.svc.policies.get("HO-4471")!.status, "expiring");
  const ev = r.svc.receiveEvidence({ evidence_id: "ev-renewal", loan_id: LOAN, policy_id: "HO-4471", channel: "vendor_feed", extraction: { confidence: FULL_CONF } }); assert.equal(ev.kind, "renewal");
  assert.equal(watch.status, "armed", "receipt alone is not confirmation");
  const confirmed = r.svc.confirmEvidence({ evidence_id: "ev-renewal", confirmed_via: "vendor" });
  const confirmedEvent = r.events.ofType("insurance.evidence.confirmed").at(-1)!; assert.equal(confirmedEvent.payload.kind, "renewal"); assert.ok(eventMatches(def("INS_EXPIRATION_WATCH_60").satisfiedPattern!, confirmedEvent));
  assert.equal(watch.status, "satisfied"); assert.equal(confirmed.verification_status, "confirmed"); assert.equal(r.svc.policies.get("HO-4471")!.renewal_evidence_on, "2027-03-10");
  r.clock.set("2027-05-01T14:00:00.000Z"); const s = await r.svc.sweep(); assert.deepEqual(s.expired, []); assert.deepEqual(s.lapses, []); assert.equal(r.timers("INS_EXPIRATION_LAPSE_1").length, 0);
  // no evidence by the expiration date → LAPSE_1 armed; the renewal verified on the grace day satisfies it (satisfied_late once breached)
  const l = rig("2026-05-01T14:00:00.000Z"); assert.equal(verifiedPolicy(l, { expiration: "2027-04-30" }).status, "verified");
  const annual = l.latest("FNMA_B202_POLICY_ANNUAL_VERIFY_365"); assert.equal(annual.dueDate, "2027-05-01");
  l.clock.set("2027-04-30T14:00:00.000Z"); await l.svc.sweep(); const lapse = l.latest("INS_EXPIRATION_LAPSE_1"); assert.equal(lapse.status, "armed"); assert.equal(lapse.dueDate, "2027-05-01");
  l.clock.set("2027-05-01T14:00:00.000Z");
  l.svc.receiveEvidence({ evidence_id: "ev-late", loan_id: LOAN, policy_id: "HO-4471", channel: "carrier_api", extraction: { confidence: FULL_CONF } }); l.svc.confirmEvidence({ evidence_id: "ev-late", confirmed_via: "carrier_api" });
  const late = l.svc.evaluatePolicy({ policy_id: "HO-4471", loan_id: LOAN, evidence_id: "ev-late", policy: GOOD, effective_date: D("2027-04-30"), expiration_date: D("2028-04-30") });
  assert.equal(late.status, "verified"); assert.equal(late.event!.payload.term, "renewal"); assert.equal(late.event!.payload.expiration_date, "2028-04-30");
  assert.ok(eventMatches(def("INS_EXPIRATION_LAPSE_1").satisfiedPattern!, late.event!)); assert.equal(lapse.status, "satisfied");
  assert.equal(annual.status, "satisfied"); assert.equal(l.latest("FNMA_B202_POLICY_ANNUAL_VERIFY_365").dueDate, "2028-04-30"); assert.equal(l.latest("INS_EXPIRATION_WATCH_60").dueDate, "2028-03-01");   // the new term's −60
  const ls = await l.svc.sweep(); assert.deepEqual(ls.lapses, []); assert.equal(l.events.ofType("insurance.lapse_detected").length, 0); assert.equal(l.svc.policies.get("HO-4471")!.status, "verified");
});
test("9.1 FNMA_B601_LPI_DOC_REQUEST_30 / FNMA_B301_FLOOD_EVIDENCE_TO_FNMA_10BD: a Fannie Mae request arms by kind and its response closes it; the LPI documentation row breaches sev-1 to the officer", () => {
  const r = rig("2026-09-14T14:00:00.000Z"); r.svc.boardLoan(loanFacts());
  const lpi = r.svc.receiveFnmaRequest({ request_id: "R-1", kind: "lpi_documentation", loan_id: LOAN });
  assert.equal(lpi.request.due, "2026-10-14"); assert.equal(lpi.request.timer, "FNMA_B601_LPI_DOC_REQUEST_30"); assert.ok(lpi.escalation_id); assert.equal(r.escalations.opened[0]!.ownerRole, "fnma_portal_operator");
  assert.ok(eventMatches(def("FNMA_B601_LPI_DOC_REQUEST_30").triggerPattern!, lpi.event)); assert.ok(!eventMatches(def("FNMA_B301_FLOOD_EVIDENCE_TO_FNMA_10BD").triggerPattern!, lpi.event));
  const b601 = r.latest("FNMA_B601_LPI_DOC_REQUEST_30"); assert.equal(b601.dueDate, "2026-10-14"); assert.equal(r.timers("FNMA_B301_FLOOD_EVIDENCE_TO_FNMA_10BD").length, 0);
  const flood = r.svc.receiveFnmaRequest({ request_id: "R-2", kind: "flood_evidence", loan_id: LOAN });
  assert.equal(flood.request.due, "2026-09-28");   // Mon 2026-09-14 + 10 Fannie Mae (ET) business days, no holiday in the span
  const b301 = r.latest("FNMA_B301_FLOOD_EVIDENCE_TO_FNMA_10BD"); assert.equal(b301.dueDate, "2026-09-28"); assert.equal(r.timers("FNMA_B601_LPI_DOC_REQUEST_30").length, 1, "a flood request does not arm the LPI row");
  assert.throws(() => r.svc.respondToFnmaRequest({ request_id: "R-2", document_ids: [] }), RangeError);
  r.clock.set("2026-09-22T14:00:00.000Z"); const fr = r.svc.respondToFnmaRequest({ request_id: "R-2", document_ids: ["doc-flood-policy"] });
  assert.equal(fr.on_time, true); assert.equal(fr.event.type, "fnma.request.responded"); assert.equal(fr.event.payload.kind, "flood_evidence");
  assert.ok(eventMatches(def("FNMA_B301_FLOOD_EVIDENCE_TO_FNMA_10BD").satisfiedPattern!, fr.event)); assert.ok(!eventMatches(def("FNMA_B601_LPI_DOC_REQUEST_30").satisfiedPattern!, fr.event));
  assert.equal(b301.status, "satisfied"); assert.equal(b601.status, "armed");
  const breaches = r.engine.evaluate("2026-10-15T04:00:00.000Z"); assert.deepEqual(breaches.map((b) => [b.def.code, b.severity, [...b.escalateTo]]), [["FNMA_B601_LPI_DOC_REQUEST_30", 1, ["officer"]]]); assert.equal(b601.status, "breached");
  r.clock.set("2026-10-16T14:00:00.000Z"); const lr = r.svc.respondToFnmaRequest({ request_id: "R-1", document_ids: ["doc-lpi-master-policy", "doc-lpi-certification"] });
  assert.equal(lr.on_time, false); assert.equal(b601.status, "satisfied_late"); assert.throws(() => r.svc.respondToFnmaRequest({ request_id: "R-1", document_ids: ["x"] }), RangeError);
  // a request dated before the sweep anchors on its own date
  const back = r.svc.receiveFnmaRequest({ request_id: "R-3", kind: "lpi_documentation", loan_id: LOAN, received_on: D("2026-10-01") }); assert.equal(back.request.due, "2026-10-31"); assert.equal(r.latest("FNMA_B601_LPI_DOC_REQUEST_30").dueDate, "2026-10-31");
});
test("9.1 FNMA_B202_INSUFFICIENCY_NOTICE_5BD closes only on the deficiency notice (INS_DEFICIENCY_NOTICE, or INS_DEFICIENCY_NOTICE_BK under a bankruptcy overlay), never on another notice.sent", async () => {
  const sat = def("FNMA_B202_INSUFFICIENCY_NOTICE_5BD").satisfiedPattern!;
  const noticeSent = (template: string): DomainEvent => ({ id: "n", type: "notice.sent", occurredAt: "2027-05-04T14:00:00.000Z", loanId: LOAN, actor: SYSTEM, payload: { template, sent_at: "2027-05-04T14:00:00.000Z" }, sequence: 1 });
  assert.ok(eventMatches(sat, noticeSent("INS_DEFICIENCY_NOTICE"))); assert.ok(eventMatches(sat, noticeSent("INS_DEFICIENCY_NOTICE_BK")));
  for (const other of ["INS_EOI_REQUEST", "INS_ANNUAL_REMINDER", "INS_FPI_FIRST_MS3A", "NTC_REGZ_41_STMT_DELQ"]) assert.ok(!eventMatches(sat, noticeSent(other)), `${other} must not close the B-2-02 SLA`);
  const rem = def("FNMA_B201_ANNUAL_INSURANCE_REMINDER_365"); assert.ok(eventMatches(rem.satisfiedPattern!, noticeSent("INS_ANNUAL_REMINDER"))); assert.ok(!eventMatches(rem.satisfiedPattern!, noticeSent("INS_DEFICIENCY_NOTICE"))); assert.equal(rem.anchorField, "sent_at");
  // Section 14 overlay: the counsel-approved _BK variant is what goes out and what closes the row
  const r = rig("2027-04-30T14:00:00.000Z");
  const res = verifiedPolicy(r, { policy: { ...GOOD, deductible_cents: 1250100n }, loan: { bankruptcy_active: true } }); assert.equal(res.status, "deficient");
  const sla = r.latest("FNMA_B202_INSUFFICIENCY_NOTICE_5BD"); await r.svc.requestEoi({ policy_id: "HO-4471" }); assert.equal(sla.status, "armed", "the EOI courtesy request does not close the insufficiency SLA");
  const sent = await r.svc.sendDeficiencyNotice({ deficiency_id: res.deficiency_id!, payload: r.sample("INS_DEFICIENCY_NOTICE_BK") });
  assert.equal(sent.template, "INS_DEFICIENCY_NOTICE_BK"); assert.equal(sent.sent, true); assert.equal(sla.status, "satisfied");
});
test("9.1 vendor feed (insurance-tracking/lpi): the inbox handler ingests each (vendor loan id, policy id, message type, vendor sequence) once, confirms a ≥ 0.90 EOI via the vendor, rejects malformed records to triage, and a carrier cancellation lapses on its effective date", async () => {
  const r = rig("2026-09-10T14:00:00.000Z"); r.svc.boardLoan(loanFacts({ vendor_loan_id: "V-91" }));
  const port = new FakeLpiTracking();
  const msg = (over: Partial<PolicyMessage>): PolicyMessage => ({ vendorLoanId: "V-91", policyId: "HO-4471", type: "policy_snapshot", vendorSequence: 1, carrier: "Test Mutual", coverageCents: 25000000n, deductibleCents: 800000n, effectiveOn: "2026-05-01", expiresOn: "2027-04-30", ...over });
  port.post(msg({ vendorSequence: 1 })); port.post(msg({ type: "eoi", vendorSequence: 2, documentSha256: "sha256:eoi" })); port.post(msg({ type: "eoi", vendorSequence: 2, documentSha256: "sha256:eoi" }));   // replayed sequence
  port.post(msg({ vendorLoanId: "V-unknown", vendorSequence: 3 })); port.post(msg({ vendorSequence: 4, coverageCents: 0n })); port.post(msg({ vendorSequence: 5, expiresOn: "2026-04-30" }));
  const d = await r.svc.drainVendorInbox(port, "2026-09-09T00:00:00.000Z", () => FULL_CONF);
  assert.equal(d.ingested.length, 2); assert.equal(d.rejected.length, 3); assert.deepEqual(d.rejected.map((x) => x.reason), ["vendor loan id V-unknown is not a tracked loan", "coverageCents must be positive", "expiresOn 2026-04-30 must follow effectiveOn 2026-05-01"]);
  assert.equal(r.svc.feedLastMessage, "2026-09-10"); assert.equal(r.events.ofType("insurance.vendor_message.rejected").length, 3);
  assert.equal(r.svc.policies.get("HO-4471")!.status, "pending_verification"); assert.equal(r.events.ofType("insurance.policy.received")[0]!.payload.source, "vendor_feed");
  const eoi = d.ingested[1]!.evidence!; assert.equal(eoi.verification_status, "confirmed"); assert.equal(eoi.confirmed_via, "vendor"); assert.equal(eoi.kind, "new"); assert.equal(eoi.document_sha256, "sha256:eoi");
  assert.equal(r.svc.ingestVendorMessage(msg({ type: "eoi", vendorSequence: 2 })).duplicate, true, "the tracker's own idempotency key drops a replay the port let through");
  assert.equal(r.svc.evaluatePolicy({ policy_id: "HO-4471", loan_id: LOAN, evidence_id: eoi.evidence_id, policy: GOOD }).status, "verified");
  // a low-confidence EOI waits for the carrier; a rating update flags re-verification; a cancellation effective 2026-10-15 lapses that day and opens 9.2
  const low = r.svc.ingestVendorMessage(msg({ type: "eoi", vendorSequence: 6 }), { confidence: { ...FULL_CONF, deductible: 0.7 } }); assert.equal(low.evidence!.verification_status, "needs_carrier_confirmation"); assert.deepEqual(low.evidence!.confirmation_required, ["deductible"]);
  assert.equal(r.svc.ingestVendorMessage(msg({ type: "rating_update", vendorSequence: 7 })).accepted, true); assert.equal(r.events.ofType("insurance.carrier_rating.updated").length, 1);
  const cancel = r.svc.ingestVendorMessage(msg({ type: "cancellation", vendorSequence: 8, cancelledOn: "2026-10-15" })); assert.equal(cancel.policy!.status, "cancelled"); assert.equal(cancel.policy!.cancellation_effective, "2026-10-15"); assert.equal(r.events.ofType("insurance.policy.cancelled").length, 1);
  r.clock.set("2026-10-14T14:00:00.000Z"); assert.deepEqual((await r.svc.sweep()).lapses, []);
  r.clock.set("2026-10-15T14:00:00.000Z"); const s = await r.svc.sweep();
  assert.equal(s.lapses.length, 1); assert.equal(s.lapses[0]!.outcome.case_status, "first_notice_pending"); assert.equal(r.events.ofType("insurance.lapse_detected")[0]!.payload.reason, "cancelled"); assert.equal(r.events.ofType("fpi.case.opened")[0]!.payload.escrowed, false);
  // reinstatement after a cancellation restores the verified term
  const re = r.svc.ingestVendorMessage(msg({ type: "reinstatement", vendorSequence: 9 })); assert.equal(re.policy!.status, "verified"); assert.equal(re.policy!.cancellation_effective, null);
});
test("9.1 recordDeficiency on the bus: a confirmed adequacy PASS emits insurance.policy.verified (arming the annual and −60 rows); a FAIL emits insurance.deficiency.detected with detected_at (the 5-BD anchor)", async () => {
  const clock = new FixedClock("2026-09-10T14:00:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["9.1"] });
  const decisions: DecisionInput[] = [];
  const ctx = { loanId: LOAN, events, ledger: new MemoryLedger(), timers, clock, decide: (d: DecisionInput) => { decisions.push(d); } } as unknown as UowContext;
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const cmds = new Map(SECTION_09_TOOLS.filter((t) => t.process === "9.1").map((t) => { const c = toolCommand(t, rt, escalates.get(t.process) ?? []); agents.registerTool(t.agent, c.name); return [t.name, c] as const; }));
  const bus = new CommandBus(agents);
  const ok = await bus.execute(cmds.get("recordDeficiency")!, INSURANCE_AGENT, { loan_id: LOAN, policy_id: "HO-4471", policy: GOOD, title_holders: ["Jane Doe"], evidence_id: "ev-1", expiration_date: "2027-04-30" }, ctx);
  assert.equal((ok.output as { status: string }).status, "verified");
  const verified = events.ofType("insurance.policy.verified")[0]!; assert.equal(verified.payload.verified_at, "2026-09-10T14:00:00.000Z"); assert.equal(verified.payload.expiration_date, "2027-04-30"); assert.equal(verified.payload.rule_set, RULE_SET_9_1);
  const forLoan = (code: string) => timers.byCode(code).filter((t) => t.loanId === LOAN);
  assert.equal(forLoan("FNMA_B202_POLICY_ANNUAL_VERIFY_365")[0]!.dueDate, "2027-09-10"); assert.equal(forLoan("INS_EXPIRATION_WATCH_60")[0]!.dueDate, "2027-03-01");
  const bad = await bus.execute(cmds.get("recordDeficiency")!, INSURANCE_AGENT, { loan_id: LOAN, policy_id: "HO-4471", policy: { ...GOOD, deductible_cents: 1250100n }, title_holders: ["Jane Doe"], evidence_id: "ev-1" }, ctx);
  assert.deepEqual((bad.output as { deficiencies: string[] }).deficiencies, ["deductible_excess"]);
  const detected = events.ofType("insurance.deficiency.detected")[0]!; assert.equal(detected.payload.detected_at, "2026-09-10T14:00:00.000Z"); assert.equal(forLoan("FNMA_B202_INSUFFICIENCY_NOTICE_5BD")[0]!.dueDate, "2026-09-17");
  assert.equal(events.ofType("insurance.policy.verified").length, 1, "a FAIL never verifies");
});
