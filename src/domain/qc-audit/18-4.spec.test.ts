// 18.4 Form 582 Lender Record Information
// spec/sections/18-qc-audit-regulatory-reporting/18-4-form-582-lender-record-information.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { fannieEt } from "../../kernel/calendar/business.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { SYSTEM, type Actor, type DomainEvent, type EventInput } from "../../kernel/events/types.ts";
import { MemoryEventStore, FixedClock } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, computeDue } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { FORM582_TOOLS_18_4, TOOLS_18_4 } from "../../app/tools/section18-4.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { form582Clocks, insuranceRequirement, insuranceAdequate, insuranceExpiryWarning, orgChangeClocks, form582SubmittedAllowed } from "./form582.ts";
import { regulatoryActionReceived, regulatoryNoticeSatisfies, subservicingScreen, type SubservicingArrangement } from "./ops.ts";
import { attestationCycleEvent } from "./ops-18-6.ts";
import {
  insuranceWorksheet, requiredInsurance, officerReviewGate, classifyOrgChange, orgChangeDeadlines, orgChangeRecorded, majorChangePlanned, majorChangeGateCleared, platformRecordWrite, corporateInsurancePolicyRecorded, insuranceExpiryCheck,
  filingSubmit, ecrmPortalTask, renderCorporateLetter, form582CycleOpen, fiscalYearEndEvent, recordRegulatoryAction, A4103_BREACH_TEXT, CONSISTENCY_CHECKS,
  regulatoryActionNoticeEvent, pendingActionsFiledEvent, partnerNotifiedEvent, majorChangeGateClearedEvent, insuranceRenewalEvent, partnerDataPackageDeliveredEvent, afsReceivedEvent, techProviderContractEvent, techProviderChangeIntent, techProviderNoticeEvent, noticeTemplatePublishedEvent, form183SubmittedEvent,
  NOTICE_STATES, lateFlag, noticeFilingOpen, noticeTransition,
  type CorporatePolicy, type FilingRow,
} from "./ops-18-4.ts";

const asEvent = (e: { type: string; payload?: Record<string, unknown> } | EventInput): DomainEvent => ({ id: "evt-18-4", occurredAt: "2026-11-10T15:00:00Z", actor: SYSTEM, sequence: 1, ...e, payload: e.payload ?? {} });
const reg = loadOverriddenRegistry();
const engineOn = (iso: string) => { const clock = new FixedClock(iso); const events = new MemoryEventStore(clock); return { clock, events, engine: new TimerEngine(reg, events, { processes: ["18.4"] }) }; };
const SUBMITTER = { kind: "human", id: "op-7", role: "fnma_portal_operator" } as const;                       // Supermortgage's designated ECRM submitter (18.4-Q1)
const PARTNER_SUBMITTER = { kind: "human", id: "partner-op-1", role: "partner_designated_submitter" } as const;   // the partner's own submitter
const OFFICER: Actor = { kind: "human", id: "off-1", role: "officer" };
const AGENT = { kind: "agent", id: "qc-audit" } as const;
const allResolved = CONSISTENCY_CHECKS.map((code) => ({ code, resolved: true }));

/** A one-process bus over the 18.4 Form 582 tools with the overridden registry's 18.4 timers armed by their events (the arrangement 18-6.spec.test.ts uses). */
function bus18_4(nowIso: string): { bus: CommandBus; clock: FixedClock; ctx: UowContext & { decisions: DecisionInput[] }; rt: ToolRuntime; run: (name: string, input: Record<string, unknown>, actor?: Actor) => Promise<unknown> } {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(reg, events, { processes: ["18.4"] });
  const ctx = { loanId: "", events, ledger: new MemoryLedger(), timers, clock, decide: (d: DecisionInput) => { decisions.push(d); }, decisions } as UowContext & { decisions: DecisionInput[] };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const bus = new CommandBus(agents);
  const escalates = loadAgentsFile().processes.find((p) => p.process === "18.4")!.escalates_to;
  const cmds = new Map(FORM582_TOOLS_18_4.map((d) => { const c = toolCommand(d, rt, escalates); agents.registerTool(d.agent, c.name); return [d.name, c] as const; }));
  return { bus, clock, ctx, rt, run: (name, input, actor = AGENT) => bus.execute(cmds.get(name)!, actor, input, ctx).then((r) => r.output) };
}

test("18.4-T1: Given partner FYE 2026-12-31, then `FNMA_A4102_FORM582_FYE_90` is due 2027-03-31 with warnings 2027-01-30 and 2027-03-01, and the partner package timer is due 2027-03-01.", () => {
  const fye = D("2026-12-31");
  const c = form582Clocks(fye);
  assert.equal(c.due, D("2027-03-31")); assert.equal(c.warn_30, D("2027-01-30")); assert.equal(c.warn_60, D("2027-03-01")); assert.equal(c.partner_package_due, D("2027-03-01")); assert.equal(c.afs_target, D("2027-03-16"));
  // the registry rows: FYE + 90 / + 60 calendar days from the `period.fiscal_year_end` tick, no business-day roll (rule 1)
  const f = reg.get("FNMA_A4102_FORM582_FYE_90")!, p = reg.get("SM_FORM582_PARTNER_PACKAGE_FYE_60")!;
  assert.deepEqual([f.offsetParsed, p.offsetParsed], [{ kind: "step", n: 90, unit: "calendar_days" }, { kind: "step", n: 60, unit: "calendar_days" }]);
  assert.equal(computeDue(f.offsetParsed, fye, 0).dueDate, D("2027-03-31")); assert.equal(computeDue(p.offsetParsed, fye, 0).dueDate, D("2027-03-01"));
  assert.equal(p.triggerPattern!.type, "period.fiscal_year_end"); assert.deepEqual(p.triggerPattern!.conditions, [{ field: "cycle", op: "=", value: "form582" }, { field: "entity", op: "=", value: "partner" }]);
  assert.deepEqual(f.triggerPattern!.conditions, [{ field: "cycle", op: "=", value: "form582" }]);   // 18.4's own scheduler tick; 18.6's attestation-cycle tick on its own subject never arms a Form 582 clock it could not close
  assert.equal(eventMatches(f.triggerPattern!, asEvent({ ...attestationCycleEvent({ entity: "partner", fye, program: { id: "prog-1", program_kind: "fnma_mbs" } }), clocks: undefined, applicability: undefined } as unknown as EventInput)), false);
  // the scheduler's `filing.form582.cycle` opens FYE + 1 with the Form 582 and AFS rows (open, due FYE + 90) and emits the `period.fiscal_year_end` tick on the partner's fiscal_year subject — the subject every satisfying event of the cycle is emitted on
  const cycle = form582CycleOpen({ entity: "partner", fye, auditor: "Auditor LLP", afs_expected_at: D("2027-03-10") });
  assert.equal(cycle.opens_on, D("2027-01-01")); assert.deepEqual(cycle.filings.map((f) => [f.id, f.filing_type, f.status, f.due_at]), [["f-582-partner-2026-12-31", "form_582", "open", D("2027-03-31")], ["f-afs-partner-2026-12-31", "afs", "open", D("2027-03-31")]]);
  assert.equal(cycle.fiscal_year.afs_commitment_ok, true); assert.equal(form582CycleOpen({ entity: "partner", fye, afs_expected_at: D("2027-03-20") }).fiscal_year.afs_commitment_ok, false);   // the auditor's commitment must sit ≥ 15 days before the deadline
  assert.equal(cycle.event.type, "period.fiscal_year_end"); assert.deepEqual(cycle.event.aggregate, { kind: "fiscal_year", id: "partner:2026-12-31" }); assert.equal(cycle.event.payload.partner_package_due, D("2027-03-01")); assert.equal(cycle.event.occurredAt, "2026-12-31T17:00:00.000Z");
  assert.equal(eventMatches(p.triggerPattern!, asEvent(cycle.event)), true); assert.equal(eventMatches(p.triggerPattern!, asEvent(fiscalYearEndEvent({ entity: "supermortgage", fye }))), false); assert.equal(eventMatches(f.triggerPattern!, asEvent(fiscalYearEndEvent({ entity: "supermortgage", fye }))), true);
  // engine: the tick arms the Form 582, AFS, auditor-delivery and partner-package clocks on the partner's fiscal year, anchored at FYE although the cycle opens the next day
  const { clock, events, engine } = engineOn("2027-01-01T12:00:00.000Z");
  events.append(cycle.event);
  const form = engine.byCode("FNMA_A4102_FORM582_FYE_90")[0]!, pkg = engine.byCode("SM_FORM582_PARTNER_PACKAGE_FYE_60")[0]!;
  assert.equal(form.dueDate, D("2027-03-31")); assert.equal(pkg.dueDate, D("2027-03-01"));
  assert.equal(engine.byCode("FNMA_A4102_AFS_FYE_90")[0]!.dueDate, D("2027-03-31")); assert.equal(engine.byCode("SM_AFS_AUDITOR_DELIVERY_FYE_75")[0]!.dueDate, D("2027-03-16"));
  // the package clock closes only on the delivery carrying the partner's receipt acknowledgment
  clock.set("2027-02-20T12:00:00.000Z");
  assert.equal(partnerDataPackageDeliveredEvent({ filing_id: "f-582-partner-2026", fye, package_document_id: "doc-pkg-1", delivered_on: D("2027-02-20"), receipt_document_id: null }), null);
  events.append(partnerDataPackageDeliveredEvent({ filing_id: "f-582-partner-2026", fye, package_document_id: "doc-pkg-1", delivered_on: D("2027-02-20"), receipt_document_id: "doc-partner-receipt-1" })!);
  assert.equal(pkg.status, "satisfied"); assert.equal(form.status, "armed");
  // the Form 582 clock: a bare `{form_582: true}` never closes it; the ECRM-confirmed submission by the designated submitter does
  clock.set("2027-03-30T12:00:00.000Z");
  events.append({ type: "filing.submitted", aggregate: { kind: "fiscal_year", id: "partner:2026-12-31" }, actor: SYSTEM, payload: { form_582: true } });
  assert.equal(form.status, "armed");
  const filing: FilingRow = { ...cycle.filings[0]!, status: "officer_review", approved_by_officer_id: "off-partner-1" };
  // the partner's own designated submitter marks the partner's filing submitted; Supermortgage's fnma_portal_operator is not the partner's submitter (prerequisites: FORM582_BUSINESS_ROLE per entity)
  assert.deepEqual(filingSubmit({ filing, actor: SUBMITTER, ecrm_confirmation_document_id: "doc-ecrm-conf-1", submitted_on: D("2027-03-30") }).refusal_codes, ["NOT_DESIGNATED_SUBMITTER"]);
  const ok = filingSubmit({ filing, actor: PARTNER_SUBMITTER, ecrm_confirmation_document_id: "doc-ecrm-conf-1", submitted_on: D("2027-03-30") });
  assert.equal(ok.allowed, true); assert.equal(ok.late, false);
  events.append(ok.event!); assert.equal(form.status, "satisfied");
  // filed 2027-04-01 the row carries the `late` flag (state machine: late when past due_at)
  assert.equal(filingSubmit({ filing, actor: PARTNER_SUBMITTER, ecrm_confirmation_document_id: "doc-ecrm-conf-1", submitted_on: D("2027-04-01") }).late, true);
  assert.equal(form582Clocks(D("2026-06-30")).due, D("2026-09-28"));
});
test("18.4-T2: Given a new CFO recorded on Tuesday 2026-11-10, then the Pending Actions update and email are due by 2026-11-18 on the `fannie_et` calendar (Veterans Day 2026-11-11 is a Fannie Mae holiday, so the five business days are 11/12, 11/13, 11/16, 11/17, 11/18) and the partner is notified by 2026-11-12 (next business day); the platform targets 11/17 to keep a day of margin.", () => {
  const recorded = D("2026-11-10");                                            // Tuesday
  assert.equal(fannieEt.isBusinessDay(D("2026-11-11")), false);               // Veterans Day
  const r = orgChangeRecorded({ entity: "supermortgage", kind: "principal_officer", occurred_on: recorded, confidence: 0.96 });
  assert.equal(r.material, true); assert.deepEqual(r.classification.classes, ["pending_actions_5bd"]); assert.equal(r.classification.decided_by, "agent");
  assert.deepEqual(r.timer!.business_days, [D("2026-11-12"), D("2026-11-13"), D("2026-11-16"), D("2026-11-17"), D("2026-11-18")]);
  assert.equal(r.timer!.due, D("2026-11-18")); assert.equal(r.timer!.unit, "business_days_fannie_et"); assert.equal(r.timer!.internal_target, D("2026-11-17"));
  assert.deepEqual(r.partner_notice, { code: "SM_PARTNER_NOTIFY_SUB_EVENT_1BD", due: D("2026-11-12") });
  assert.deepEqual(r.pending_action, { entity: "supermortgage", event_kind: "principal_officer", occurred_at: recorded, fnma_due_at: D("2026-11-18"), form582_updated_at: null, email_sent_at: null, document_id: null });
  assert.equal(r.draft!.template, "F582-PENDING-v1"); assert.equal(r.draft!.recipient, "changes_in_lender_organization_mailbox");
  // the section calculator and the corrected deadlines agree
  const o = orgChangeClocks("pending_actions_5bd", recorded, null); assert.equal(o.fnma_due, D("2026-11-18")); assert.equal(o.partner_due, D("2026-11-12")); assert.equal(o.internal_target, D("2026-11-17"));
  assert.deepEqual(orgChangeDeadlines("pending_actions_5bd", recorded, null), { fnma_due: D("2026-11-18"), partner_due: D("2026-11-12"), internal_target: D("2026-11-17"), already_passed: false, unit: "business_days_fannie_et" });
  // registry: `org.change.recorded{material}` arms +5 business_days_fannie_et from occurred_at
  const def = reg.get("FNMA_A4102_ORG_CHANGE_5BD")!;
  assert.equal(eventMatches(def.triggerPattern!, asEvent(r.event)), true); assert.equal(computeDue(def.offsetParsed, recorded, 0).dueDate, D("2026-11-18"));
  // an address change is on the A4-1-03 60-day list only: not material for the 5-BD clock, no Pending Actions row
  const addr = orgChangeRecorded({ entity: "supermortgage", kind: "principal_address", occurred_on: recorded, confidence: 0.96 });
  assert.equal(addr.material, false); assert.equal(addr.timer, null); assert.equal(addr.pending_action, null); assert.equal(eventMatches(def.triggerPattern!, asEvent(addr.event)), false);
  // engine: armed on the recorded event with due 11-18; the Pending Actions update alone does not close it; both evidenced does
  const { clock, events, engine } = engineOn("2026-11-10T20:00:00.000Z");
  events.append(r.event);
  const id = r.event.aggregate!.id;
  const inst = engine.byCode("FNMA_A4102_ORG_CHANGE_5BD")[0]!; assert.equal(inst.anchorDate, recorded); assert.equal(inst.dueDate, D("2026-11-18"));
  // the partner clock: the same recording emits `partner.reportable_event.occurred` on the org_change (a Supermortgage event the partner must report), arming SM_PARTNER_NOTIFY_SUB_EVENT_1BD due 11-12 (next business day); only the evidenced `partner.notified` on that subject closes it
  assert.equal(r.partner_event!.type, "partner.reportable_event.occurred"); assert.deepEqual(r.partner_event!.aggregate, { kind: "org_change", id });
  const pnDef = reg.get("SM_PARTNER_NOTIFY_SUB_EVENT_1BD")!; assert.equal(eventMatches(pnDef.triggerPattern!, asEvent(r.partner_event!)), true);
  events.append(r.partner_event!);
  const pn = engine.byCode("SM_PARTNER_NOTIFY_SUB_EVENT_1BD")[0]!; assert.equal(pn.dueDate, D("2026-11-12")); assert.deepEqual(pn.subject, { kind: "org_change", id });
  clock.set("2026-11-11T15:00:00.000Z");
  events.append({ type: "partner.notified", aggregate: { kind: "org_change", id }, actor: SYSTEM, payload: { kind: "reportable_event", event_kind: "principal_officer", evidence_document_id: null } });
  assert.equal(pn.status, "armed");
  events.append(partnerNotifiedEvent({ sent: true, evidence_document_id: "doc-partner-mail-1", subject: { kind: "org_change", id }, event_kind: "principal_officer", notified_on: D("2026-11-11") })!);
  assert.equal(pn.status, "satisfied"); assert.equal(inst.status, "armed");
  assert.equal(orgChangeRecorded({ entity: "partner", kind: "principal_officer", occurred_on: recorded, confidence: 0.96 }).partner_event, null);   // the partner's own change is not a Supermortgage event
  // recorded late (edge case "Ownership change discovered late"): the same change recorded Fri 11-13 still anchors both clocks on the occurrence (registry anchor `occurrence` = the payload's occurred_at, never the recording day) — the partner notice was due 11-12 and is breached the moment it is recorded; the 5-BD clock still lands 11-18
  assert.equal(pnDef.anchorField, "occurred_at"); assert.equal(def.anchorField, "occurred_at");
  {
    const late = engineOn("2026-11-13T15:00:00.000Z");
    late.events.append(r.event); late.events.append(r.partner_event!);
    const lp = late.engine.byCode("SM_PARTNER_NOTIFY_SUB_EVENT_1BD")[0]!, lo = late.engine.byCode("FNMA_A4102_ORG_CHANGE_5BD")[0]!;
    assert.equal(lp.anchorDate, recorded); assert.equal(lp.dueDate, D("2026-11-12")); assert.equal(lo.anchorDate, recorded); assert.equal(lo.dueDate, D("2026-11-18"));
    assert.deepEqual(late.engine.evaluate("2026-11-13T15:00:00.000Z").map((b) => [b.def.code, b.severity]), [["SM_PARTNER_NOTIFY_SUB_EVENT_1BD", 1]]);
  }
  clock.set("2026-11-16T19:00:00.000Z");
  events.append({ type: "org_change.notice.filed", aggregate: { kind: "org_change", id }, actor: SYSTEM, payload: { pending_actions_document_id: "doc-582-pa-1", email_evidence_document_id: null } });
  assert.equal(inst.status, "armed");
  events.append(pendingActionsFiledEvent({ org_change_id: id, entity: "supermortgage", event_kind: "principal_officer", form582_updated_at: "2026-11-16T14:00:00Z", pending_actions_document_id: "doc-582-pa-1", email_sent_at: "2026-11-16T14:05:00Z", email_evidence_document_id: "doc-mail-1" })!);
  assert.equal(inst.status, "satisfied");
  // the Pending Actions notice quotes A4-1-02 and goes to the mailbox
  const letter = renderCorporateLetter("F582-PENDING-v1", { entity: "Supermortgage", event_kind: "principal_officer", occurred_on: recorded, description: "new Chief Financial Officer", fnma_due_at: r.timer!.due });
  assert.equal(letter.allowed, true); assert.match(letter.letter!.body, /"within five business days of the occurrence" \(Selling Guide A4-1-02\)/); assert.equal(letter.letter!.recipient, "Changes in Lender Organization mailbox");
  assert.match(renderCorporateLetter("F582-PENDING-v1", { entity: "Supermortgage" }).refusal!, /missing event_kind, occurred_on, description, fnma_due_at/);
});
test("18.4-T3: Given highest monthly servicing UPB $5,000,000,000, then required fidelity = $5,525,000, E&O = $5,525,000, max deductible $828,750; a policy at $5,000,000 fails the adequacy check and blocks `officer_review`.", () => {
  const upb = 500_000_000_000n;                                                // $5,000,000,000
  const w = insuranceWorksheet({ highest_monthly_servicing_upb_cents: upb });
  assert.equal(w.fidelity_cents, 552_500_000n); assert.equal(w.eo_cents, 552_500_000n); assert.equal(w.max_deductible_cents, 82_875_000n); assert.equal(w.deductible_rule, "15_pct");
  const req = requiredInsurance(upb);
  assert.deepEqual(req, { fidelity_cents: 552_500_000n, eo_cents: 552_500_000n, max_deductible_cents: 82_875_000n });
  assert.deepEqual(insuranceRequirement(upb), req);                            // the section calculator agrees at this UPB
  assert.equal(insuranceAdequate(500_000_000n, 552_500_000n, req), false);     // a $5,000,000 fidelity policy
  assert.equal(insuranceAdequate(552_500_000n, 552_500_000n, req), true);
  const blocked = officerReviewGate({ checks: allResolved, insurance: { policy_fidelity_cents: 500_000_000n, policy_eo_cents: 552_500_000n, required: req } });
  assert.equal(blocked.allowed, false); assert.equal(blocked.next_status, null); assert.deepEqual(blocked.blocking, ["insurance adequacy: fidelity 500000000¢ < required 552500000¢ (A3-5-02)"]); assert.match(blocked.refusal!, /^officer_review blocked: insurance adequacy/);
  assert.deepEqual(officerReviewGate({ checks: allResolved, insurance: { policy_fidelity_cents: 552_500_000n, policy_eo_cents: 552_500_000n, required: req } }), { allowed: true, next_status: "officer_review", blocking: [], refusal: null });
  // an E&O policy short of the requirement blocks on A3-5-03
  assert.match(officerReviewGate({ checks: allResolved, insurance: { policy_fidelity_cents: 552_500_000n, policy_eo_cents: 500_000_000n, required: req } }).refusal!, /E&O 500000000¢ < required 552500000¢ \(A3-5-03\)/);
  // where form582.insuranceRequirement departs from A3-5-02 (shared-calculator defect, corrected by requiredInsurance): $80M UPB → deductible the greater of 10% / $100,000, not 15%; $200B → the $150M cap
  assert.equal(requiredInsurance(8_000_000_000n).max_deductible_cents, 10_000_000n); assert.equal(insuranceRequirement(8_000_000_000n).max_deductible_cents, 4_500_000n);
  assert.equal(requiredInsurance(20_000_000_000_000n).fidelity_cents, 15_000_000_000n); assert.ok(insuranceRequirement(20_000_000_000_000n).fidelity_cents > 15_000_000_000n);
});
test("18.4-T4: Given a fidelity policy expiring 2027-02-15 with no renewal recorded by 2027-01-16, then the expiry timer breaches and the Form 582 cycle is flagged.", () => {
  const policy: CorporatePolicy = { policy_id: "pol-fid-2026", entity: "partner", kind: "fidelity", expires_on: D("2027-02-15"), coverage_cents: 552_500_000n, fnma_loss_payee: true };
  const rec = corporateInsurancePolicyRecorded(policy);
  assert.deepEqual(rec.timer, { code: "FNMA_A3501_INSURANCE_EXPIRY_30", anchor: D("2027-02-15"), due: D("2027-01-16") }); assert.equal(insuranceExpiryWarning(D("2027-02-15")), rec.timer.due); assert.equal(rec.loss_payee_check!.resolved, true); assert.equal(rec.loss_payee_check!.code, "insurance_fnma_loss_payee");
  const cycle = { filing_id: "f-582-partner-2026", status: "data_assembled" };
  // 2027-01-15: armed, nothing flagged; 2027-01-16 is the due day itself — "by 2027-01-16" runs to the end of that day, as the engine's deadline below does — so still open, due today
  const before = insuranceExpiryCheck({ policy, renewals: [], as_of: D("2027-01-15"), form582_cycle: cycle });
  assert.equal(before.timer.status, "armed"); assert.equal(before.timer.due_today, false); assert.equal(before.escalation, null); assert.equal(before.form582_cycle_flag, null);
  const dueDay = insuranceExpiryCheck({ policy, renewals: [], as_of: D("2027-01-16"), form582_cycle: cycle });
  assert.equal(dueDay.timer.status, "armed"); assert.equal(dueDay.timer.due_today, true); assert.equal(dueDay.form582_cycle_flag, null);
  // no renewal recorded by 2027-01-16: from 01-17 breached (sev-1 → officer) and the open Form 582 cycle is flagged — an unresolved consistency check that blocks officer_review
  const breach = insuranceExpiryCheck({ policy, renewals: [], as_of: D("2027-01-17"), form582_cycle: cycle });
  assert.equal(breach.timer.status, "breached"); assert.equal(breach.timer.due, D("2027-01-16")); assert.equal(breach.renewal, null);
  assert.equal(breach.escalation!.kind, "officer"); assert.equal(breach.escalation!.severity, "sev1"); assert.match(breach.escalation!.reason, /fidelity policy pol-fid-2026 expires 2027-02-15: no renewal recorded by 2027-01-16/); assert.equal(breach.escalation!.due, D("2027-02-15"));
  const flag = breach.form582_cycle_flag!;
  assert.equal(flag.filing_id, "f-582-partner-2026"); assert.equal(flag.flag, "INSURANCE_EXPIRY_UNRENEWED"); assert.equal(flag.verify_blocked, true); assert.equal(flag.policy_id, "pol-fid-2026");
  assert.equal(flag.consistency_check.code, "insurance_not_expired"); assert.equal(flag.consistency_check.resolved, false);
  const gate = officerReviewGate({ checks: [...allResolved.filter((c) => c.code !== "insurance_not_expired"), flag.consistency_check], insurance: null });
  assert.equal(gate.allowed, false); assert.equal(gate.next_status, null); assert.match(gate.refusal!, /consistency check insurance_not_expired unresolved \(fidelity policy pol-fid-2026 expires 2027-02-15: no renewal recorded by 2027-01-16/);
  // a renewal recorded 2027-01-10 effective 2027-02-15 (no lapse) satisfies, as does one recorded on 01-16 itself; effective 2027-02-20 it is a lapse; a cyber renewal is another policy; without evidence it does not count; recorded after the anchor it satisfies late
  const ok = { policy_id: "pol-fid-2026", renewal_effective_on: D("2027-02-15"), recorded_on: D("2027-01-10"), document_id: "doc-binder-1" };
  const at = (renewals: (typeof ok)[], as_of = D("2027-01-17")) => insuranceExpiryCheck({ policy, renewals, as_of, form582_cycle: cycle });
  assert.equal(at([ok]).timer.status, "satisfied"); assert.equal(at([ok]).form582_cycle_flag, null); assert.equal(at([ok]).escalation, null);
  assert.equal(at([{ ...ok, recorded_on: D("2027-01-16") }], D("2027-01-16")).timer.status, "satisfied"); assert.equal(at([{ ...ok, recorded_on: D("2027-01-16") }]).timer.status, "satisfied");
  assert.equal(at([{ ...ok, renewal_effective_on: D("2027-02-20") }]).timer.status, "breached");
  assert.equal(at([{ ...ok, policy_id: "pol-cyber-2026" }]).timer.status, "breached");
  assert.equal(at([{ ...ok, document_id: null as unknown as string }]).timer.status, "breached");
  assert.equal(at([{ ...ok, recorded_on: D("2027-01-20") }], D("2027-01-20")).timer.status, "satisfied_late");
  assert.equal(insuranceExpiryCheck({ policy, renewals: [], as_of: D("2027-01-17"), form582_cycle: { filing_id: "f-582-partner-2025", status: "accepted" } }).form582_cycle_flag, null);
  // engine: the recorded event arms the per-policy clock (anchor expires_on − 30 = 2027-01-16); past end of that day it breaches at sev-1; a cyber renewal never touches it; the fidelity renewal closes it late
  const { clock, events, engine } = engineOn("2026-02-15T12:00:00.000Z");
  events.append(rec.event);
  const inst = engine.byCode("FNMA_A3501_INSURANCE_EXPIRY_30")[0]!;
  assert.equal(inst.anchorDate, D("2027-02-15")); assert.equal(inst.dueDate, D("2027-01-16")); assert.deepEqual(inst.subject, { kind: "corporate_insurance_policy", id: "pol-fid-2026" });
  assert.deepEqual(engine.evaluate("2027-01-16T12:00:00.000Z"), []);
  const breaches = engine.evaluate("2027-01-17T05:30:00.000Z");              // 00:30 ET on 01-17: the 01-16 deadline has passed
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.severity, 1); assert.equal(inst.status, "breached"); assert.match(breaches[0]!.breachText, /Form 582 cannot verify with an expired policy/);
  clock.set("2027-01-20T12:00:00.000Z");
  events.append(insuranceRenewalEvent({ policy_id: "pol-cyber-2026", kind: "cyber", prior_expires_on: D("2027-02-15"), renewal_effective_on: D("2027-02-15"), renewal_document_id: "doc-cyber-1" })!);
  assert.equal(inst.status, "breached");
  events.append(insuranceRenewalEvent({ policy_id: "pol-fid-2026", kind: "fidelity", prior_expires_on: D("2027-02-15"), renewal_effective_on: D("2027-02-15"), renewal_document_id: "doc-binder-1" })!);
  assert.equal(inst.status, "satisfied_late");
  // a fidelity policy without the Fannie Mae loss-payee endorsement is itself an unresolved check (A3-5-01) under its own code — not the expiry check's
  const lp = corporateInsurancePolicyRecorded({ ...policy, fnma_loss_payee: false }).loss_payee_check!;
  assert.equal(lp.code, "insurance_fnma_loss_payee"); assert.equal(lp.resolved, false); assert.match(lp.detail!, /lacks the Fannie Mae loss-payee endorsement/);
  assert.match(officerReviewGate({ checks: [lp], insurance: null }).refusal!, /consistency check insurance_fnma_loss_payee unresolved \(fidelity policy pol-fid-2026 lacks the Fannie Mae loss-payee endorsement/);
  assert.equal(corporateInsurancePolicyRecorded({ ...policy, kind: "cyber" }).loss_payee_check, null);
});
test("18.4-T5: Given a planned 10% equity sale with effective date 2027-05-01 recorded 2027-03-20, then the gate `FNMA_A4103_MAJOR_CHANGE_ADVANCE_60` shows the notice deadline already passed (needed by 2027-03-02) and escalates to `officer`/`attorney`.", () => {
  const r = majorChangePlanned({ entity: "partner", kind: "owner_5pct", planned_effective_on: D("2027-05-01"), recorded_on: D("2027-03-20"), ownership_pct_bps: 1000 });
  assert.equal(r.gate.code, "FNMA_A4103_MAJOR_CHANGE_ADVANCE_60"); assert.equal(r.gate.anchor, D("2027-05-01")); assert.equal(r.gate.notice_needed_by, D("2027-03-02"));
  assert.equal(r.gate.already_passed, true); assert.equal(r.gate.days_late, 18); assert.equal(r.gate.prior_approval_required, true); assert.equal(r.gate.blocked, true);
  // breach action: the change is blocked in the platform's own records — the partner's org_registry owner row at 10% is refused while the gate is open; an officer row is not covered by an ownership gate, nor a holding under 5%, nor another entity; the change's own write (org_change_id) is covered whatever its shape
  const gates = [r.gate_record]; assert.equal(r.gate_record.cleared, null); assert.equal(r.gate_record.org_change_id, r.event.aggregate!.id); assert.equal(r.gate_record.notice_needed_by, D("2027-03-02"));
  const ownerWrite = { record: "org_registry", role: "owner", ownership_pct_bps: 1000, effective_from: D("2027-05-01") } as const;
  const refusedWrite = platformRecordWrite({ entity: "partner", write: ownerWrite, gates });
  assert.equal(refusedWrite.allowed, false); assert.equal(refusedWrite.blocked_by, r.gate_record);
  assert.match(refusedWrite.refusal!, /^org_registry owner row effective 2027-05-01 blocked in the platform's own records: owner_5pct planned 2027-05-01 \(prior approval and 60 days' advance written notice needed by 2027-03-02\) awaits Fannie Mae approval\/acknowledgment or an officer waiver with rationale \(FNMA_A4103_MAJOR_CHANGE_ADVANCE_60; Selling Guide A4-1-03\)$/);
  assert.equal(platformRecordWrite({ entity: "partner", write: { record: "org_registry", role: "officer", effective_from: D("2027-04-01") }, gates }).allowed, true);
  assert.equal(platformRecordWrite({ entity: "partner", write: { record: "org_registry", role: "owner", ownership_pct_bps: 300, effective_from: D("2027-05-01") }, gates }).allowed, true);
  assert.equal(platformRecordWrite({ entity: "supermortgage", write: ownerWrite, gates }).allowed, true);
  assert.equal(platformRecordWrite({ entity: "partner", write: { record: "entity_profile", field: "other", effective_from: D("2027-05-01"), org_change_id: r.gate_record.org_change_id }, gates }).allowed, false);
  assert.deepEqual(r.escalations.map((e) => [e.kind, e.severity, e.due]), [["officer", "sev1", D("2027-03-20")], ["attorney", "sev1", D("2027-03-20")]]);
  assert.match(r.escalations[0]!.reason, /needed by 2027-03-02 \(18 days ago\)/); assert.match(r.escalations[1]!.reason, /requiring prior written approval/);
  assert.equal(r.breach, A4103_BREACH_TEXT); assert.match(r.breach!, /is a breach of the Lender Contract/);
  assert.equal(r.draft.template, "ORG-CHG-NOTICE-v1"); assert.equal(r.draft.kind, "prior_approval_request"); assert.equal(r.draft.drafted_on, D("2027-03-20"));
  // discovered late: the 5-BD Pending Actions update applies after occurrence as well (rule 4: a new 5%+ owner is on both lists; 2027-05-01 is a Saturday)
  assert.deepEqual(r.pending_actions_after_occurrence, { code: "FNMA_A4102_ORG_CHANGE_5BD", anchor: D("2027-05-01"), due: D("2027-05-07") });
  assert.deepEqual(classifyOrgChange({ kind: "owner_5pct", confidence: 0.95, occurred_on: D("2027-03-20") }).classes, ["major_change_60d_advance", "pending_actions_5bd"]);
  // the section calculator agrees on the dates
  const m = orgChangeClocks("major_change_60d_advance", D("2027-03-20"), D("2027-05-01")); assert.equal(m.fnma_due, D("2027-03-02")); assert.ok(m.already_passed);
  assert.equal(orgChangeDeadlines("major_change_60d_advance", D("2027-03-20"), D("2027-05-01")).fnma_due, D("2027-03-02"));
  // recorded in time (2027-02-01): the officer signs the prior-approval request by 03-02; no breach, no sev-1
  const early = majorChangePlanned({ entity: "partner", kind: "owner_5pct", planned_effective_on: D("2027-05-01"), recorded_on: D("2027-02-01"), ownership_pct_bps: 1000 });
  assert.equal(early.gate.already_passed, false); assert.equal(early.gate.days_late, 0); assert.equal(early.breach, null); assert.deepEqual(early.escalations.map((e) => [e.kind, e.severity, e.due]), [["officer", "sev2", D("2027-03-02")]]);
  // a merger brings counsel in even when timely; a 5-BD-only kind is not an A4-1-03 change
  assert.deepEqual(majorChangePlanned({ entity: "partner", kind: "merger_or_reorganization", planned_effective_on: D("2027-05-01"), recorded_on: D("2027-02-01") }).escalations.map((e) => e.kind), ["officer", "attorney"]);
  assert.throws(() => majorChangePlanned({ entity: "partner", kind: "breach_of_agreement", planned_effective_on: D("2027-05-01"), recorded_on: D("2027-03-20") }), RangeError);
  // registry: −60 calendar days from planned_effective_date; breached on evaluation the day it is recorded; cleared only by approval/acknowledgment or an officer waiver with rationale
  const def = reg.get("FNMA_A4103_MAJOR_CHANGE_ADVANCE_60")!;
  assert.equal(def.kindNorm, "not_before_gate"); assert.equal(eventMatches(def.triggerPattern!, asEvent(r.event)), true); assert.equal(computeDue(def.offsetParsed, D("2027-05-01"), 0).dueDate, D("2027-03-02"));
  const { events, engine } = engineOn("2027-03-20T15:00:00.000Z");
  events.append(r.event);
  const inst = engine.byCode("FNMA_A4103_MAJOR_CHANGE_ADVANCE_60")[0]!; assert.equal(inst.anchorDate, D("2027-05-01")); assert.equal(inst.dueDate, D("2027-03-02"));
  const breaches = engine.evaluate("2027-03-20T15:00:00.000Z");
  assert.equal(breaches.length, 1); assert.deepEqual([...breaches[0]!.escalateTo], ["officer"]); assert.match(breaches[0]!.breachText, /`officer` waiver with rationale/); assert.equal(inst.status, "breached");
  assert.equal(majorChangeGateClearedEvent({ org_change_id: r.event.aggregate!.id, by: "officer_waiver", document_id: "doc-waiver-1", officer_id: "off-1", rationale: null }), null);
  assert.equal(majorChangeGateClearedEvent({ org_change_id: r.event.aggregate!.id, by: "officer_waiver", document_id: null, officer_id: "off-1", rationale: "late discovery" }), null);
  // a raw waiver on the log without the rationale (`basis`) or the signed waiver (`document_id`) does not match the pattern either
  assert.equal(eventMatches(def.satisfiedPattern!, asEvent({ type: "org_change.gate.cleared", aggregate: { kind: "org_change", id: r.event.aggregate!.id }, payload: { by: "officer_waiver", document_id: "doc-waiver-1" } })), false);
  assert.equal(eventMatches(def.satisfiedPattern!, asEvent({ type: "org_change.gate.cleared", aggregate: { kind: "org_change", id: r.event.aggregate!.id }, payload: { by: "officer_waiver", basis: "late discovery" } })), false);
  const waiver = majorChangeGateClearedEvent({ org_change_id: r.event.aggregate!.id, by: "officer_waiver", document_id: "doc-waiver-1", officer_id: "off-1", rationale: "investor crossed 5% via secondary purchase; Fannie Mae notified 2027-03-20 with explanation" })!;
  assert.deepEqual(waiver.actor, { kind: "human", id: "off-1", role: "officer" }); assert.equal(waiver.payload.basis, waiver.payload.rationale);
  events.append(waiver);
  assert.equal(inst.status, "satisfied_late");
  // cleared, the write goes through in the platform's own records; a clearance on another org_change never clears this gate
  const clearedGate = majorChangeGateCleared(r.gate_record, waiver, D("2027-03-21"));
  assert.equal(clearedGate.cleared!.by, "officer_waiver"); assert.equal(clearedGate.cleared!.document_id, "doc-waiver-1"); assert.equal(platformRecordWrite({ entity: "partner", write: ownerWrite, gates: [clearedGate] }).allowed, true);
  assert.throws(() => majorChangeGateCleared(r.gate_record, { ...waiver, aggregate: { kind: "org_change", id: "partner:owner_5pct:2028-01-01" } }, D("2027-03-21")), RangeError);
  // the letter requests prior approval and gives the A4-1-03 notice
  const letter = renderCorporateLetter("ORG-CHG-NOTICE-v1", { entity: "Partner Bank", kind: "owner_5pct", planned_effective_on: D("2027-05-01"), description: "sale of a 10% equity interest", prior_approval_required: true });
  assert.equal(letter.allowed, true); assert.match(letter.letter!.body, /"60 days' advance written notice" and requests prior written approval under Selling Guide A4-1-03/); assert.equal(letter.letter!.recipient, "Fannie Mae customer account team");
});
test("18.4-T6: Given a state consent order received, then a written notice is drafted and escalated the same day and the timer is satisfied only by sent evidence.", () => {
  const received = D("2026-11-10");                                             // Tuesday; Veterans Day 11-11 is a holiday on every calendar
  const r = recordRegulatoryAction({ received_on: received, kind: "state_consent_order", regulator: "NY DFS", entity: "supermortgage", document_id: "doc-consent-order-1" });
  const base = regulatoryActionReceived({ received_on: received, kind: "state_consent_order", regulator: "NY DFS", entity: "supermortgage" });   // ops.ts's rule, plus the events that arm its clocks
  assert.deepEqual(r.draft, base.draft); assert.deepEqual(r.timer, base.timer); assert.deepEqual(r.escalations, base.escalations); assert.deepEqual(r.partner_notice, base.partner_notice);
  // drafted and escalated the same day
  assert.equal(r.draft.drafted_on, received); assert.equal(r.draft.template, "ORG-CHG-NOTICE-v1"); assert.equal(r.draft.kind, "regulatory_action_notice");
  assert.equal(r.draft.recipient, "fnma_customer_account_team"); assert.equal(r.draft.action, "state_consent_order"); assert.match(r.draft.citation, /A4-1-03: immediate written notice of regulatory actions/);
  assert.deepEqual(r.escalations.map((e) => [e.kind, e.severity, e.due]), [["officer", "sev1", received], ["attorney", "sev1", received]]);
  // the 1-BD internal proxy for "immediate": Tue 11-10 → Thu 11-12; the partner (subservicing clause) is notified by the same next business day; the corrected deadlines agree (form582.orgChangeClocks("immediate") would say the same day)
  assert.equal(r.timer.code, "FNMA_A4103_REGULATORY_ACTION_IMMEDIATE"); assert.equal(r.timer.anchor, received); assert.equal(r.timer.due, D("2026-11-12"));
  assert.deepEqual(r.partner_notice, { code: "SM_PARTNER_NOTIFY_SUB_EVENT_1BD", due: D("2026-11-12") });
  assert.deepEqual(orgChangeDeadlines("immediate", received, null), { fnma_due: D("2026-11-12"), partner_due: D("2026-11-12"), internal_target: received, already_passed: false, unit: "business_days_servicer" });
  // rule 4: a regulatory action is on the "immediate" list only (not A4-1-02 5-BD, not A4-1-03 60-day)
  const cls = classifyOrgChange({ kind: "regulatory_action", confidence: 0.97, occurred_on: received });
  assert.deepEqual(cls.classes, ["immediate"]); assert.equal(cls.prior_approval_required, false); assert.equal(cls.decided_by, "agent"); assert.equal(cls.escalation, null);
  // satisfied only by sent evidence: a draft, or "sent" without an evidence pointer, never satisfies the timer
  assert.equal(regulatoryNoticeSatisfies({ sent: false, evidence_document_id: null }), false);
  assert.equal(regulatoryNoticeSatisfies({ sent: true, evidence_document_id: null }), false);
  assert.equal(regulatoryNoticeSatisfies({ sent: true, evidence_document_id: "" }), false);
  assert.equal(regulatoryNoticeSatisfies({ sent: true, evidence_document_id: "doc-sent-mail-0417" }), true);
  const def = reg.get("FNMA_A4103_REGULATORY_ACTION_IMMEDIATE")!;
  assert.equal(def.triggerPattern!.type, "regulatory.action.received"); assert.deepEqual(def.offsetParsed, { kind: "step", n: 1, unit: "business_days_servicer", note: 'internal proxy for "immediate"' });
  assert.equal(def.satisfiedPattern!.type, "regulatory.action.notice_sent"); assert.deepEqual(def.satisfiedPattern!.conditions, [{ field: "evidence_document_id", op: "is not null" }]);
  assert.equal(r.timer.satisfied_by, def.satisfiedPattern!.raw);                // the process names the very event the registry waits for
  const ra = r.regulatory_action_id; assert.equal(ra, "supermortgage:state_consent_order:NY DFS:2026-11-10");
  assert.equal(regulatoryActionNoticeEvent({ sent: false, evidence_document_id: null, regulatory_action_id: ra, sent_on: null, regulator: "NY DFS", entity: "supermortgage" }), null);
  assert.equal(regulatoryActionNoticeEvent({ sent: true, evidence_document_id: null, regulatory_action_id: ra, sent_on: received, regulator: "NY DFS", entity: "supermortgage" }), null);
  const sent = regulatoryActionNoticeEvent({ sent: true, evidence_document_id: "doc-sent-mail-0417", regulatory_action_id: ra, sent_on: received, regulator: "NY DFS", entity: "supermortgage", sent_by: "off-1" })!;
  assert.equal(sent.type, "regulatory.action.notice_sent"); assert.equal(sent.payload.recipient, "fnma_customer_account_team"); assert.equal(sent.payload.sent_on, received); assert.deepEqual(sent.aggregate, { kind: "regulatory_action", id: ra }); assert.deepEqual(sent.actor, { kind: "human", id: "off-1", role: "officer" });
  assert.equal(eventMatches(def.satisfiedPattern!, asEvent(sent)), true);
  // engine: `regulatory.action.received` arms the 1-BD clock (due 11-12) and, for a Supermortgage action, the partner clock on the same regulatory_action subject; the draft and an un-evidenced "sent" leave both open; the sent evidence closes the first, the partner notice the second
  assert.equal(eventMatches(def.triggerPattern!, asEvent(r.event)), true); assert.equal(r.partner_event!.type, "partner.reportable_event.occurred"); assert.deepEqual(r.event.aggregate, { kind: "regulatory_action", id: ra });
  const { clock, events, engine } = engineOn("2026-11-10T16:00:00.000Z");
  events.append(r.event); events.append(r.partner_event!);
  const inst = engine.byCode("FNMA_A4103_REGULATORY_ACTION_IMMEDIATE")[0]!, pn = engine.byCode("SM_PARTNER_NOTIFY_SUB_EVENT_1BD")[0]!;
  assert.equal(inst.anchorDate, received); assert.equal(inst.dueDate, D("2026-11-12")); assert.deepEqual(inst.subject, { kind: "regulatory_action", id: ra }); assert.equal(pn.dueDate, D("2026-11-12"));
  events.append({ type: "regulatory.action.notice_drafted", aggregate: { kind: "regulatory_action", id: ra }, actor: SYSTEM, payload: { document_id: "draft-1" } });
  events.append({ type: "regulatory.action.notice_sent", aggregate: { kind: "regulatory_action", id: ra }, actor: SYSTEM, payload: { evidence_document_id: null, sent: true } });
  assert.equal(inst.status, "armed"); assert.equal(pn.status, "armed");
  clock.set("2026-11-12T20:00:00.000Z");
  events.append(sent); assert.equal(inst.status, "satisfied"); assert.equal(pn.status, "armed");
  events.append(partnerNotifiedEvent({ sent: true, evidence_document_id: "doc-partner-mail-2", subject: { kind: "regulatory_action", id: ra }, event_kind: "state_consent_order", notified_on: D("2026-11-12") })!); assert.equal(pn.status, "satisfied");
  // recorded after receipt: the order received Tue 11-10 but recorded Fri 11-13 anchors on `received_on` (registry anchor `receipt`), so both clocks were due 11-12 and breach sev-1 as soon as they are recorded — the process's own figure, never the recording day
  assert.equal(def.anchorField, "received_on");
  {
    const late = engineOn("2026-11-13T15:00:00.000Z");
    late.events.append(r.event); late.events.append(r.partner_event!);
    const li = late.engine.byCode("FNMA_A4103_REGULATORY_ACTION_IMMEDIATE")[0]!, lp = late.engine.byCode("SM_PARTNER_NOTIFY_SUB_EVENT_1BD")[0]!;
    assert.equal(li.anchorDate, received); assert.equal(li.dueDate, D("2026-11-12")); assert.equal(li.dueDate, r.timer.due); assert.equal(lp.anchorDate, received); assert.equal(lp.dueDate, D("2026-11-12"));
    assert.deepEqual(late.engine.evaluate("2026-11-13T15:00:00.000Z").map((b) => [b.def.code, b.severity]), [["FNMA_A4103_REGULATORY_ACTION_IMMEDIATE", 1], ["SM_PARTNER_NOTIFY_SUB_EVENT_1BD", 1]]);
  }
  assert.equal(eventMatches(def.satisfiedPattern!, asEvent({ type: "regulatory.action.notice_sent", payload: { evidence_document_id: null } })), false);
  assert.equal(eventMatches(def.satisfiedPattern!, asEvent({ type: "regulatory.action.notice_drafted", payload: { document_id: "draft-1" } })), false);
  // the same-day draft renders as the A4-1-03 "immediate written notice"
  const letter = renderCorporateLetter("ORG-CHG-NOTICE-v1", { entity: "Supermortgage", kind: "regulatory_action", regulator: "NY DFS", description: "consent order dated 2026-11-10" });
  assert.equal(letter.allowed, true); assert.match(letter.letter!.body, /"immediate written notice" under Selling Guide A4-1-03 of a regulatory action by NY DFS/);
  // a partner's own consent order is the partner's duty: no partner-notify clock, Supermortgage supports
  assert.equal(regulatoryActionReceived({ received_on: received, kind: "state_consent_order", regulator: "CA DFPI", entity: "partner" }).partner_notice, null);
  assert.equal(recordRegulatoryAction({ received_on: received, kind: "state_consent_order", regulator: "CA DFPI", entity: "partner" }).partner_event, null);
});
test("18.4-T7: Given the agent attempts to mark a filing `submitted` without an ECRM confirmation document, then the transition is refused.", async () => {
  const filing: FilingRow = { id: "f-582-sm-2026", entity: "supermortgage", filing_type: "form_582", period_end: D("2026-12-31"), due_at: D("2027-03-31"), status: "officer_review", approved_by_officer_id: "off-1" };
  const on = D("2027-03-20");
  // the agent, without an ECRM confirmation document: refused on both counts; the row stays in officer_review and nothing is emitted
  const r = filingSubmit({ filing, actor: AGENT, ecrm_confirmation_document_id: null, submitted_on: on });
  assert.equal(r.allowed, false); assert.deepEqual(r.refusal_codes, ["AGENT_CANNOT_SUBMIT", "ECRM_CONFIRMATION_REQUIRED"]); assert.equal(r.state, "officer_review"); assert.equal(r.event, null); assert.equal(r.submission_evidence, null);
  assert.match(r.refusal!, /agent qc-audit cannot mark a filing submitted — Form 582 is an officer certification/); assert.match(r.refusal!, /no ECRM submission confirmation document captured/);
  // the agent with a confirmation document is still refused (guardrail: the agent cannot certify or submit); the designated submitter without one is refused on the ECRM ground alone
  assert.deepEqual(filingSubmit({ filing, actor: AGENT, ecrm_confirmation_document_id: "doc-ecrm-1", submitted_on: on }).refusal_codes, ["AGENT_CANNOT_SUBMIT"]);
  assert.deepEqual(filingSubmit({ filing, actor: SUBMITTER, ecrm_confirmation_document_id: null, submitted_on: on }).refusal_codes, ["ECRM_CONFIRMATION_REQUIRED"]);
  assert.deepEqual(filingSubmit({ filing, actor: SUBMITTER, ecrm_confirmation_document_id: "", submitted_on: on }).refusal_codes, ["ECRM_CONFIRMATION_REQUIRED"]);
  // the officer is not the submitter; a row not yet in officer_review; a row without the officer approval record
  assert.deepEqual(filingSubmit({ filing, actor: { kind: "human", id: "off-1", role: "officer" }, ecrm_confirmation_document_id: "doc-ecrm-1", submitted_on: on }).refusal_codes, ["NOT_DESIGNATED_SUBMITTER"]);
  const partnerOp = filingSubmit({ filing, actor: PARTNER_SUBMITTER, ecrm_confirmation_document_id: "doc-ecrm-1", submitted_on: on });   // the partner's submitter is not Supermortgage's
  assert.deepEqual(partnerOp.refusal_codes, ["NOT_DESIGNATED_SUBMITTER"]); assert.match(partnerOp.refusal!, /partner_designated_submitter is not supermortgage's designated ECRM submitter \(FORM582_BUSINESS_ROLE: fnma_portal_operator\)/);
  assert.deepEqual(filingSubmit({ filing: { ...filing, status: "registry_verified" }, actor: SUBMITTER, ecrm_confirmation_document_id: "doc-ecrm-1", submitted_on: on }).refusal_codes, ["INVALID_TRANSITION"]);
  assert.deepEqual(filingSubmit({ filing: { ...filing, approved_by_officer_id: null }, actor: SUBMITTER, ecrm_confirmation_document_id: "doc-ecrm-1", submitted_on: on }).refusal_codes, ["OFFICER_APPROVAL_REQUIRED"]);
  // the designated submitter with the confirmation and the officer's approval: submitted, on time, and the event is the one FNMA_A4102_FORM582_FYE_90 waits for
  const ok = filingSubmit({ filing, actor: SUBMITTER, ecrm_confirmation_document_id: "doc-ecrm-1", submitted_on: on });
  assert.equal(ok.allowed, true); assert.deepEqual(ok.refusal_codes, []); assert.equal(ok.state, "submitted"); assert.equal(ok.late, false); assert.equal(ok.submission_evidence, "doc-ecrm-1");
  assert.equal(ok.event!.type, "filing.submitted"); assert.equal(ok.event!.actor.id, "op-7"); assert.deepEqual(ok.event!.aggregate, { kind: "fiscal_year", id: "supermortgage:2026-12-31" });
  assert.deepEqual(ok.event!.payload, { form: "form_582", filing_id: "f-582-sm-2026", entity: "supermortgage", period_end: D("2026-12-31"), ecrm_confirmation_document_id: "doc-ecrm-1", approved_by_officer_id: "off-1", submitted_by: "op-7", submitted_on: on, late: false });
  const def = reg.get("FNMA_A4102_FORM582_FYE_90")!;
  assert.equal(def.satisfiedPattern!.type, "filing.submitted"); assert.deepEqual(def.satisfiedPattern!.conditions, [{ field: "form", op: "=", value: "form_582" }, { field: "ecrm_confirmation_document_id", op: "is not null" }, { field: "approved_by_officer_id", op: "is not null" }]);
  assert.equal(eventMatches(def.satisfiedPattern!, asEvent(ok.event!)), true);
  // what never closes the clock: a bare `{form_582: true}`, the 18.7 Form 1002 submission shape, a Form 582 event without the confirmation
  assert.equal(eventMatches(def.satisfiedPattern!, asEvent({ type: "filing.submitted", payload: { form_582: true } })), false);
  assert.equal(eventMatches(def.satisfiedPattern!, asEvent({ type: "filing.submitted", payload: { form: "form_1002", quarter: 4, webmb_confirmation: "w-1", ceo_cfo_certification: "c-1" } })), false);
  assert.equal(eventMatches(def.satisfiedPattern!, asEvent({ type: "filing.submitted", payload: { form: "form_582", ecrm_confirmation_document_id: null, approved_by_officer_id: "off-1" } })), false);
  // the AFS row: the same transition needs the ECRM upload confirmation and the statements package with the accountant's opinion
  const afs: FilingRow = { id: "f-afs-sm-2026", entity: "supermortgage", filing_type: "afs", period_end: D("2026-12-31"), due_at: D("2027-03-31"), status: "open", approved_by_officer_id: null, package_document_id: "doc-afs-1" };
  assert.deepEqual(filingSubmit({ filing: afs, actor: AGENT, ecrm_confirmation_document_id: null, submitted_on: on }).refusal_codes, ["AGENT_CANNOT_SUBMIT", "ECRM_CONFIRMATION_REQUIRED"]);
  assert.deepEqual(filingSubmit({ filing: { ...afs, package_document_id: null }, actor: SUBMITTER, ecrm_confirmation_document_id: "doc-ecrm-afs-1", submitted_on: on }).refusal_codes, ["AFS_PACKAGE_REQUIRED"]);
  const afsOk = filingSubmit({ filing: afs, actor: SUBMITTER, ecrm_confirmation_document_id: "doc-ecrm-afs-1", submitted_on: on });
  const afsDef = reg.get("FNMA_A4102_AFS_FYE_90")!;
  assert.equal(eventMatches(afsDef.satisfiedPattern!, asEvent(afsOk.event!)), true); assert.equal(eventMatches(afsDef.satisfiedPattern!, asEvent({ type: "filing.submitted", payload: { afs: true } })), false); assert.equal(eventMatches(afsDef.satisfiedPattern!, asEvent(ok.event!)), false);
  // the ECRM portal task itself is never created without the officer approval record, and carries it for the submitter
  assert.match(ecrmPortalTask({ filing: { ...filing, approved_by_officer_id: null }, answer_sheet_document_id: "doc-sheet-1", evidence_index_document_id: "doc-idx-1" }).refusal!, /without an officer approval record — the agent cannot certify/);
  const task = ecrmPortalTask({ filing, answer_sheet_document_id: "doc-sheet-1", evidence_index_document_id: "doc-idx-1" });
  assert.equal(task.allowed, true); assert.equal(task.task!.assignee_role, "fnma_portal_operator"); assert.equal(task.task!.approved_by_officer_id, "off-1"); assert.equal(task.task!.due_at, D("2027-03-31")); assert.equal(task.task!.capture, "submission confirmation → documents");
  // the section calculator's null check agrees
  assert.equal(form582SubmittedAllowed(null), false); assert.equal(form582SubmittedAllowed("doc-ecrm-1"), true);
  // on the bus: the agent's `filing.transition{to: submitted}` is refused before anything runs (FORM582_AGENT_CANNOT_SUBMIT), the designated submitter without the confirmation with the typed reason, the officer as not the submitter; with the confirmation the row is submitted and the FYE clock closes
  const b = bus18_4("2027-03-20T15:00:00.000Z");
  await b.run("filing.cycle.open", { entity: "supermortgage", fye: "2026-12-31", auditor: "Auditor LLP", afs_expected_at: "2027-03-10" });
  const fid = "f-582-supermortgage-2026-12-31";
  b.rt.store.put("regulatory_filings", fid, { status: "officer_review", approved_by_officer_id: "off-1" }, OFFICER, b.clock.now());
  const fyeClock = b.ctx.timers.byCode("FNMA_A4102_FORM582_FYE_90")[0]!; assert.equal(fyeClock.dueDate, D("2027-03-31")); assert.deepEqual(fyeClock.subject, { kind: "fiscal_year", id: "supermortgage:2026-12-31" });
  const refused = (name: string, input: Record<string, unknown>, code: string, actor?: Actor) => assert.rejects(b.run(name, input, actor), (e: Error) => e instanceof CommandRefused && e.code === code, `${name} → ${code}`);
  await refused("filing.transition", { filing_id: fid, to: "submitted", ecrm_confirmation_document_id: "doc-ecrm-1" }, "FORM582_AGENT_CANNOT_SUBMIT");
  await refused("filing.transition", { filing_id: fid, to: "submitted" }, "ECRM_CONFIRMATION_REQUIRED", SUBMITTER);
  await refused("filing.transition", { filing_id: fid, to: "submitted", ecrm_confirmation_document_id: "doc-ecrm-1" }, "FORM582_DESIGNATED_SUBMITTER", OFFICER);
  await refused("filing.transition", { filing_id: fid, to: "submitted", ecrm_confirmation_document_id: "doc-ecrm-1" }, "NOT_DESIGNATED_SUBMITTER", PARTNER_SUBMITTER);
  assert.equal(b.rt.store.get("regulatory_filings", fid)!.data.status, "officer_review"); assert.equal(b.ctx.events.ofType("command.refused").length, 4); assert.equal(fyeClock.status, "armed");
  const done = await b.run("filing.transition", { filing_id: fid, to: "submitted", ecrm_confirmation_document_id: "doc-ecrm-1" }, SUBMITTER) as { status: string; late: boolean };
  assert.equal(done.status, "submitted"); assert.equal(done.late, false); assert.equal(fyeClock.status, "satisfied");
  assert.deepEqual([b.rt.store.get("regulatory_filings", fid)!.data.status, b.rt.store.get("regulatory_filings", fid)!.data.late, b.rt.store.get("regulatory_filings", fid)!.data.submission_evidence], ["submitted", false, "doc-ecrm-1"]);
});
test(`18.4-T8: Given Supermortgage's own Form 582 cycle, then the subservicing screen answers "subservice for others = YES" listing the partner's servicer number and FYE loan count/UPB reconciled to Section 5 position data.`, () => {
  const fye = D("2026-12-31");
  const partnerToSm: SubservicingArrangement = { master_entity: "partner", sub_entity: "supermortgage", master_servicer_number: "26555", sub_servicer_number: "27888", loan_count: 24_600, upb_cents: 500_000_000_000n, status: "active" };
  const formerMaster: SubservicingArrangement = { master_entity: "former-partner", sub_entity: "supermortgage", master_servicer_number: "26111", sub_servicer_number: "27888", loan_count: 900, upb_cents: 18_000_000_000n, status: "terminated" };
  const position = { loan_count: 24_600, upb_cents: 500_000_000_000n };        // Section 5 LSDU / Servicing Platform position as of FYE
  const s = subservicingScreen({ entity: "supermortgage", fye, arrangements: [partnerToSm, formerMaster], section5_position: position });
  assert.equal(s.subservice_for_others, "YES"); assert.equal(s.use_subservicer, "NO");   // "use a subservicer = NO" unless Supermortgage itself subcontracts
  assert.deepEqual(s.listed, [{ servicer_number: "26555", entity: "partner", loan_count: 24_600, upb_cents: 500_000_000_000n, as_of: fye }]);   // the terminated master is not listed
  assert.equal(s.reconciled, true); assert.deepEqual(s.variance, { loan_count: 0, upb_cents: 0n }); assert.equal(s.verify_allowed, true); assert.equal(s.refusal, null);
  assert.equal(subservicingScreen({ entity: "supermortgage", fye, arrangements: [partnerToSm], section5_position: position, subcontracts_servicing: true }).use_subservicer, "YES");
  // a Section 5 position one loan / $250,000 apart: the screen cannot be verified and says by how much
  const off = subservicingScreen({ entity: "supermortgage", fye, arrangements: [partnerToSm], section5_position: { loan_count: 24_599, upb_cents: 499_975_000_000n } });
  assert.equal(off.reconciled, false); assert.equal(off.verify_allowed, false); assert.deepEqual(off.variance, { loan_count: 1, upb_cents: 25_000_000n }); assert.match(off.refusal!, /Section 5 position by 1 loans \/ 25000000¢/);
  // the partner's Form 582 mirrors it: "use a subservicer = YES" listing Supermortgage's servicer number, "subservice for others = NO"
  const p = subservicingScreen({ entity: "partner", fye, arrangements: [partnerToSm, formerMaster], section5_position: position });
  assert.equal(p.use_subservicer, "YES"); assert.equal(p.subservice_for_others, "NO"); assert.deepEqual(p.listed.map((l) => [l.servicer_number, l.entity, l.loan_count]), [["27888", "supermortgage", 24_600]]);
  // multiple partners: Supermortgage lists each master, reconciled to the combined position
  const second: SubservicingArrangement = { ...partnerToSm, master_entity: "partner-2", master_servicer_number: "26777", loan_count: 5_400, upb_cents: 120_000_000_000n };
  const two = subservicingScreen({ entity: "supermortgage", fye, arrangements: [partnerToSm, second], section5_position: { loan_count: 30_000, upb_cents: 620_000_000_000n } });
  assert.deepEqual(two.listed.map((l) => l.servicer_number), ["26555", "26777"]); assert.equal(two.reconciled, true);
  // an unreconciled screen is an unresolved consistency check, and that blocks officer_review
  const gate = officerReviewGate({ checks: [{ code: "officers_match_resolutions", resolved: true }, { code: "subservicing_matches_section5_position", resolved: off.reconciled, detail: off.refusal! }], insurance: null });
  assert.equal(gate.allowed, false); assert.equal(gate.next_status, null); assert.match(gate.refusal!, /subservicing_matches_section5_position unresolved \(subservicing screen cannot be verified/);
  assert.deepEqual(officerReviewGate({ checks: [{ code: "officers_match_resolutions", resolved: true }], insurance: null }), { allowed: true, next_status: "officer_review", blocking: [], refusal: null });
  // the answer sheet (F582-PKG-v1) carries the screen with its evidence pointer; a changed answer without one is not rendered (rule 2)
  const screens = [{ screen: "Subservicing", answers: [{ question: "Do you subservice for others?", answer: `YES — partner 26555, ${s.listed[0]!.loan_count} loans, ${s.listed[0]!.upb_cents}¢ as of ${fye}`, changed: true, evidence_document_id: "doc-sub-recon-2026" }, { question: "Do you use a subservicer?", answer: "NO", changed: false, evidence_document_id: null }] }];
  const pkg = renderCorporateLetter("F582-PKG-v1", { entity: "Supermortgage", fye, due_at: D("2027-03-31"), screens, approved_by_officer_id: "off-1" });
  assert.equal(pkg.allowed, true); assert.deepEqual(pkg.letter!.evidence_document_ids, ["doc-sub-recon-2026"]); assert.match(pkg.letter!.body, /Do you subservice for others\?: YES — partner 26555, 24600 loans/); assert.match(pkg.letter!.body, /no later than 90 days after the end of the seller\/servicer's fiscal year/);
  const bare = renderCorporateLetter("F582-PKG-v1", { entity: "Supermortgage", fye, due_at: D("2027-03-31"), screens: [{ screen: "Subservicing", answers: [{ question: "Do you subservice for others?", answer: "YES", changed: true, evidence_document_id: null }] }] });
  assert.equal(bare.allowed, false); assert.match(bare.refusal!, /changed answers without an evidence pointer — Subservicing: Do you subservice for others\?/);
});

test("18.4 worked figures: FYE 2026-12-31 → Form 582 due 2027-03-31 (warnings 2027-01-30, 2027-03-01), partner package 2027-03-01 (day 60), AFS auditor delivery 2027-03-16 (day 75); FYE 2026-06-30 → 2026-09-28; highest monthly servicing UPB $5,000,000,000 → fidelity $300,000 + $600,000 + $625,000 + $4,000,000 = $5,525,000; E&O $5,525,000 (below the $10M cap); max deductible 15% = $828,750; a $5,000,000 policy fails and blocks officer_review", () => {
  const c = form582Clocks(D("2026-12-31"));
  assert.equal(c.due, D("2027-03-31")); assert.equal(c.warn_30, D("2027-01-30")); assert.equal(c.warn_60, D("2027-03-01")); assert.equal(c.partner_package_due, D("2027-03-01")); assert.equal(c.afs_target, D("2027-03-16"));
  assert.equal(form582Clocks(D("2026-06-30")).due, D("2026-09-28"));            // no business-day roll: 2026-09-28 is a Monday anyway
  const w = insuranceWorksheet({ highest_monthly_servicing_upb_cents: 500_000_000_000n });
  assert.equal(w.basis, "highest_monthly_servicing_upb"); assert.equal(w.basis_cents, 500_000_000_000n);
  assert.equal(w.minimum_cents, 30_000_000n);                                    // $300,000 up to $100M
  assert.equal(w.tier_next_400m_cents, 60_000_000n);                             // 0.0015 × 400,000,000 = $600,000
  assert.equal(w.tier_next_500m_cents, 62_500_000n);                             // 0.00125 × 500,000,000 = $625,000
  assert.equal(w.tier_above_1b_cents, 400_000_000n);                             // 0.0010 × 4,000,000,000 = $4,000,000
  assert.equal(w.minimum_cents + w.tier_next_400m_cents + w.tier_next_500m_cents + w.tier_above_1b_cents, w.fidelity_uncapped_cents);
  assert.equal(w.fidelity_cents, 552_500_000n); assert.equal(w.eo_cents, 552_500_000n); assert.equal(w.eo_cap_cents, 1_000_000_000n);
  assert.equal(w.deductible_rule, "15_pct"); assert.equal(w.max_deductible_cents, 82_875_000n);
  const req = requiredInsurance(500_000_000_000n);                               // the requirement the gate uses is the worksheet's; the section calculator agrees at this UPB
  assert.deepEqual(req, { fidelity_cents: 552_500_000n, eo_cents: 552_500_000n, max_deductible_cents: 82_875_000n }); assert.deepEqual(insuranceRequirement(500_000_000_000n), req);
  assert.equal(insuranceAdequate(552_500_000n, 552_500_000n, req), true);
  assert.equal(insuranceAdequate(500_000_000n, 552_500_000n, req), false);
  const g = officerReviewGate({ checks: [], insurance: { policy_fidelity_cents: 500_000_000n, policy_eo_cents: 552_500_000n, required: req } });
  assert.equal(g.allowed, false); assert.equal(g.next_status, null); assert.match(g.refusal!, /fidelity 500000000¢ < required 552500000¢ \(A3-5-02\)/);
  // the E&O cap and the small-servicer deductible rule: $12B UPB → fidelity $300,000 + $600,000 + $625,000 + $11,000,000 = $12,525,000, E&O capped at $10M (uncapped under the $30M SF + multifamily cap); $80M UPB → $300,000 minimum, deductible the greater of 10% / $100,000
  const big = insuranceWorksheet({ highest_monthly_servicing_upb_cents: 1_200_000_000_000n });
  assert.equal(big.tier_above_1b_cents, 1_100_000_000n); assert.equal(big.fidelity_cents, 1_252_500_000n); assert.equal(big.eo_cents, 1_000_000_000n); assert.equal(insuranceWorksheet({ highest_monthly_servicing_upb_cents: 1_200_000_000_000n, multifamily: true }).eo_cents, 1_252_500_000n);
  const small = insuranceWorksheet({ highest_monthly_servicing_upb_cents: 8_000_000_000n });
  assert.equal(small.fidelity_cents, 30_000_000n); assert.equal(small.deductible_rule, "greater_of_10_pct_or_100000"); assert.equal(small.max_deductible_cents, 10_000_000n);
  // the $150M fidelity cap: $200B UPB → $300,000 + $600,000 + $625,000 + $199,000,000 = $200,525,000 uncapped → $150,000,000
  const capped = insuranceWorksheet({ highest_monthly_servicing_upb_cents: 20_000_000_000_000n });
  assert.equal(capped.fidelity_uncapped_cents, 20_052_500_000n); assert.equal(capped.fidelity_cents, 15_000_000_000n); assert.equal(capped.eo_cents, 1_000_000_000n);
  // rule 3: a pure servicer's originations are zero, so the basis is always the servicing UPB
  assert.equal(insuranceWorksheet({ highest_monthly_servicing_upb_cents: 500_000_000_000n, annual_originations_upb_cents: 0n }).basis, "highest_monthly_servicing_upb");
  assert.equal(insuranceWorksheet({ highest_monthly_servicing_upb_cents: 500_000_000_000n, annual_originations_upb_cents: 700_000_000_000n }).basis_cents, 700_000_000_000n);
});

test("18.4 timers: every row armable and satisfiable; every satisfying event is emitted with evidence; rule 4 lists; confidence < 0.9 → officer", () => {
  const codes = ["FNMA_A2101_TECH_PROVIDER_BREACH_5BD", "FNMA_A2101_TECH_PROVIDER_CHANGE_180", "FNMA_A3501_INSURANCE_EXPIRY_30", "FNMA_A4102_AFS_FYE_90", "FNMA_A4102_FORM582_FYE_90", "FNMA_A4102_ORG_CHANGE_5BD", "FNMA_A4103_MAJOR_CHANGE_ADVANCE_60", "FNMA_A4103_REGULATORY_ACTION_IMMEDIATE", "FNMA_A42106_FORM183_ON_CHANGE", "FNMA_ISBR_ANNUAL_ATTESTATION", "SM_AFS_AUDITOR_DELIVERY_FYE_75", "SM_FORM582_PARTNER_PACKAGE_FYE_60", "SM_PARTNER_NOTIFY_SUB_EVENT_1BD"];
  for (const code of codes) {
    const t = reg.get(code)!;
    assert.ok(t.offsetParsed.kind !== "prose" && t.triggerPattern !== null && t.triggerPattern.type.includes("."), `${code} armable`);
    assert.ok(t.offsetParsed.kind === "evaluator" || (t.satisfiedPattern !== null && t.satisfiedPattern.type.includes(".")), `${code} satisfiable`);
  }
  // SM_PARTNER_NOTIFY_SUB_EVENT_1BD: armed by `partner.reportable_event.occurred` (orgChangeRecorded / recordRegulatoryAction for a Supermortgage event), closed by the evidenced notice on the same subject
  const pn = reg.get("SM_PARTNER_NOTIFY_SUB_EVENT_1BD")!;
  assert.equal(eventMatches(pn.satisfiedPattern!, asEvent(partnerNotifiedEvent({ sent: true, evidence_document_id: "doc-partner-1", subject: { kind: "org_change", id: "supermortgage:principal_officer:2026-11-10" }, event_kind: "principal_officer", notified_on: D("2026-11-11") })!)), true);
  assert.equal(partnerNotifiedEvent({ sent: true, evidence_document_id: null, subject: { kind: "org_change", id: "x" }, event_kind: "principal_officer", notified_on: D("2026-11-11") }), null);
  assert.equal(eventMatches(pn.triggerPattern!, asEvent(orgChangeRecorded({ entity: "supermortgage", kind: "owner_5pct", occurred_on: D("2026-11-10"), confidence: 0.95 }).partner_event!)), true);
  // FNMA_A4103_MAJOR_CHANGE_ADVANCE_60: an approval or acknowledgment (letter + its reference), or an officer waiver WITH the signed waiver and a rationale — never an agent override, never a bare `{by}`
  const mc = reg.get("FNMA_A4103_MAJOR_CHANGE_ADVANCE_60")!;
  assert.deepEqual(mc.satisfiedPattern!.conditions, [{ field: "by", op: "in", value: ["fnma_approval", "fnma_acknowledgment", "officer_waiver"] }, { field: "document_id", op: "is not null" }, { field: "basis", op: "is not null" }]);
  const approved = majorChangeGateClearedEvent({ org_change_id: "partner:owner_5pct:2027-05-01", by: "fnma_approval", document_id: "doc-fnma-approval-1", fnma_reference: "Fannie Mae approval letter 2027-03-25" })!;
  assert.equal(eventMatches(mc.satisfiedPattern!, asEvent(approved)), true); assert.equal(approved.payload.basis, "Fannie Mae approval letter 2027-03-25"); assert.equal(approved.actor.kind, "agent");
  assert.equal(majorChangeGateClearedEvent({ org_change_id: "partner:owner_5pct:2027-05-01", by: "fnma_approval", document_id: "doc-fnma-approval-1" }), null);   // an approval is recorded with its reference
  const waived = majorChangeGateClearedEvent({ org_change_id: "partner:owner_5pct:2027-05-01", by: "officer_waiver", document_id: "doc-waiver-1", officer_id: "off-1", rationale: "investor crossed 5% via secondary purchase; notice sent with explanation" })!;
  assert.equal(waived.actor.role, "officer"); assert.equal(eventMatches(mc.satisfiedPattern!, asEvent(waived)), true);
  assert.equal(eventMatches(mc.satisfiedPattern!, asEvent({ type: "org_change.gate.cleared", payload: { by: "agent_override", document_id: "x", basis: "y" } })), false);
  assert.equal(eventMatches(mc.satisfiedPattern!, asEvent({ type: "org_change.gate.cleared", payload: { by: "officer_waiver" } })), false);
  assert.equal(eventMatches(mc.satisfiedPattern!, asEvent({ type: "org_change.gate.cleared", payload: { by: "officer_waiver", document_id: "doc-waiver-1", basis: null } })), false);
  // FNMA_A3501_INSURANCE_EXPIRY_30: expires 2027-02-15 → anchor 2027-01-16; a renewal effective after expiry is a lapse; the pattern binds the policy
  const ins = reg.get("FNMA_A3501_INSURANCE_EXPIRY_30")!;
  assert.equal(ins.anchorField, "expires_on"); assert.equal((ins.offsetParsed as { n: number }).n, -30); assert.deepEqual(ins.satisfiedPattern!.conditions, [{ field: "lapse", op: "=", value: "false" }, { field: "policy_id", op: "is not null" }]);
  assert.equal(eventMatches(ins.satisfiedPattern!, asEvent(insuranceRenewalEvent({ policy_id: "pol-1", kind: "fidelity", prior_expires_on: D("2027-02-15"), renewal_effective_on: D("2027-02-15"), renewal_document_id: "doc-binder-1" })!)), true);
  assert.equal(eventMatches(ins.satisfiedPattern!, asEvent(insuranceRenewalEvent({ policy_id: "pol-1", kind: "fidelity", prior_expires_on: D("2027-02-15"), renewal_effective_on: D("2027-02-20"), renewal_document_id: "doc-binder-2" })!)), false);
  assert.equal(eventMatches(ins.satisfiedPattern!, asEvent({ type: "corporate_insurance_policy.renewed", payload: { lapse: false } })), false);
  assert.equal(insuranceRenewalEvent({ policy_id: "pol-1", kind: "fidelity", prior_expires_on: D("2027-02-15"), renewal_effective_on: D("2027-02-15"), renewal_document_id: null }), null);
  // SM_AFS_AUDITOR_DELIVERY_FYE_75: the auditor's evidenced upload; with the opinion it is also what 18.1's CSBS row waits for
  const afs = reg.get("SM_AFS_AUDITOR_DELIVERY_FYE_75")!;
  const received = afsReceivedEvent({ entity: "supermortgage", fye: D("2026-12-31"), auditor: "Auditor LLP", document_id: "doc-afs-1", audit_opinion: true, received_on: D("2027-03-10") })!;
  assert.equal(eventMatches(afs.satisfiedPattern!, asEvent(received)), true); assert.equal(eventMatches(afs.satisfiedPattern!, asEvent({ type: "afs.received", payload: { document_id: null } })), false);
  assert.equal(afsReceivedEvent({ entity: "supermortgage", fye: D("2026-12-31"), auditor: "Auditor LLP", document_id: null, audit_opinion: true, received_on: D("2027-03-10") }), null);
  assert.equal(eventMatches(reg.get("CSBS_EXTERNAL_AUDIT_ANNUAL")!.satisfiedPattern!, asEvent(received)), true);
  // A2-1-01: the 180-day change gate and the 5-BD breach clock close only on the sent TECH-PROV-NOTICE-v1 letter's evidence
  const change = reg.get("FNMA_A2101_TECH_PROVIDER_CHANGE_180")!, breach = reg.get("FNMA_A2101_TECH_PROVIDER_BREACH_5BD")!;
  assert.equal(change.anchorField, "planned_effective_date"); assert.equal((change.offsetParsed as { n: number }).n, -180); assert.equal(computeDue(change.offsetParsed, D("2027-09-01"), 0).dueDate, D("2027-03-05"));
  const intent = techProviderChangeIntent({ entity: "partner", provider: "Supermortgage", planned_effective_date: D("2027-09-01"), declared_on: D("2027-02-01"), loan_count: 24_600 });
  assert.equal(intent.applies, true); assert.equal(intent.gate.notice_needed_by, D("2027-03-05")); assert.equal(intent.gate.already_passed, false); assert.equal(intent.gate.blocked, true); assert.equal(eventMatches(change.triggerPattern!, asEvent(intent.event!)), true);
  assert.equal(techProviderChangeIntent({ entity: "partner", provider: "Supermortgage", planned_effective_date: D("2027-09-01"), declared_on: D("2027-02-01"), loan_count: 12_000 }).event, null);   // under 20,000 loans A2-1-01 does not apply
  assert.equal(techProviderChangeIntent({ entity: "partner", provider: "Supermortgage", planned_effective_date: D("2027-09-01"), declared_on: D("2027-04-01"), loan_count: 24_600 }).escalation!.severity, "sev1");
  const planned = techProviderNoticeEvent({ sent: true, evidence_document_id: "doc-tech-1", kind: "planned_change", change_id: intent.change_id, provider: "Supermortgage", loan_count: 24_600, sent_on: D("2027-03-01"), sent_by: "off-partner-1", entity: "partner" })!;
  assert.equal(planned.type, "tech_provider.change.notice_sent"); assert.equal(planned.payload.applies, true); assert.equal(eventMatches(change.satisfiedPattern!, asEvent(planned)), true); assert.equal(eventMatches(breach.satisfiedPattern!, asEvent(planned)), false);
  {
    const { events, engine } = engineOn("2027-02-01T15:00:00.000Z");
    events.append(intent.event!); const g = engine.byCode("FNMA_A2101_TECH_PROVIDER_CHANGE_180")[0]!; assert.equal(g.anchorDate, D("2027-09-01")); assert.equal(g.dueDate, D("2027-03-05")); assert.deepEqual(g.subject, { kind: "tech_provider_change", id: intent.change_id });
    events.append(planned as EventInput); assert.equal(g.status, "satisfied");
  }
  // the breach clock: a termination/breach/impairment under a technology contract arms it on the `contract_events` subject (the shape 19.3's notices.draft records); the officer-recorded `fnma_notices.sent{kind=a2101_event_5bd}` — 19.3's own event — closes it; a copies notice, a draft or an un-evidenced record does not
  const ce = techProviderContractEvent({ contract_id: "c-printmail-1", entity: "supermortgage", provider: "print-mail-vendor", kind: "termination", occurred_on: D("2027-03-01"), loan_count: 24_600 });
  assert.equal(ce.contract_event_id, "ce-c-printmail-1-2027-03-01-termination"); assert.equal(ce.timer.due, D("2027-03-08")); assert.equal(eventMatches(breach.triggerPattern!, asEvent(ce.event)), true); assert.equal(ce.escalation.severity, "sev1"); assert.equal(ce.draft.template, "TECH-PROV-NOTICE-v1");
  assert.equal(eventMatches(reg.get("FNMA_A2101_CONTRACT_EVENT_NOTICE_5BD")!.triggerPattern!, asEvent(ce.event)), true);   // 19.3's row arms on the same event
  const term = techProviderNoticeEvent({ sent: true, evidence_document_id: "doc-tech-2", kind: "termination", contract_event_id: ce.contract_event_id, provider: "print-mail-vendor", loan_count: 24_600, sent_on: D("2027-03-03"), sent_by: "off-1", entity: "supermortgage" })!;
  assert.equal(term.type, "fnma_notices.sent"); assert.equal(term.payload.kind, "a2101_event_5bd"); assert.deepEqual(term.aggregate, { kind: "contract_events", id: ce.contract_event_id }); assert.equal(eventMatches(breach.satisfiedPattern!, asEvent(term)), true); assert.equal(eventMatches(change.satisfiedPattern!, asEvent(term)), false);
  assert.equal(eventMatches(reg.get("FNMA_A2101_CONTRACT_EVENT_NOTICE_5BD")!.satisfiedPattern!, asEvent(term)), true);   // and 19.3's row is satisfied by it
  // the reverse direction: 19.3's own `notices.draft` shape — contract_kind as 19.3 classifies it (tech_provider_addendum / subservicing_agreement / integration_agreement, or null with a critical servicing function) — arms this row through `fnma_notice_required`, 19.3's rule-5 verdict for "under a technology contract"; a non-technology contract, or a kind outside termination/breach/impairment, does not
  const shaped = (p: Record<string, unknown>) => asEvent({ type: "contract_event.occurred", actor: SYSTEM, aggregate: { kind: "contract_events", id: "ce-19-3" }, payload: { contract_event_id: "ce-19-3", contract_id: "c-1", kind: "termination", direction: "sent_to_servicer", occurred_on: "2027-03-01", occurred_at: "2027-03-01", contract_kind: "tech_provider_addendum", critical_servicing_function: null, fnma_notice_required: true, copies_required: true, ...p } });
  assert.deepEqual(breach.triggerPattern!.conditions, [{ field: "kind", op: "in", value: ["termination", "breach", "impairment"] }, { field: "fnma_notice_required", op: "=", value: "true" }]);
  assert.equal(eventMatches(breach.triggerPattern!, shaped({})), true);
  assert.equal(eventMatches(breach.triggerPattern!, shaped({ contract_kind: null, critical_servicing_function: true })), true);
  assert.equal(eventMatches(breach.triggerPattern!, shaped({ contract_kind: "subservicing_agreement", kind: "breach" })), true);
  assert.equal(eventMatches(breach.triggerPattern!, shaped({ contract_kind: "vendor_msa", critical_servicing_function: false, fnma_notice_required: false })), false);
  assert.equal(eventMatches(breach.triggerPattern!, shaped({ kind: "default_notice" })), false);
  assert.equal(breach.anchorField, "occurred_on");
  {
    // recorded three days after the termination: anchored on the occurrence, due 03-08 (5 business days), on the contract_events subject 19.3's notice closes
    const { events, engine } = engineOn("2027-03-04T15:00:00.000Z");
    events.append({ type: "contract_event.occurred", aggregate: { kind: "contract_events", id: "ce-19-3" }, actor: SYSTEM, occurredAt: "2027-03-04T15:00:00.000Z", payload: shaped({}).payload });
    const b = engine.byCode("FNMA_A2101_TECH_PROVIDER_BREACH_5BD")[0]!; assert.equal(b.anchorDate, D("2027-03-01")); assert.equal(b.dueDate, D("2027-03-08")); assert.deepEqual(b.subject, { kind: "contract_events", id: "ce-19-3" });
    assert.equal(engine.byCode("FNMA_A2101_CONTRACT_EVENT_NOTICE_5BD").length, 0);   // the engine is filtered to 18.4 here; 19.3's row arms in its own process
  }
  assert.equal(techProviderNoticeEvent({ sent: true, evidence_document_id: null, kind: "termination", contract_event_id: ce.contract_event_id, provider: "print-mail-vendor", loan_count: 24_600, sent_on: D("2027-03-01"), sent_by: "off-1", entity: "supermortgage" }), null);
  {
    const { clock, events, engine } = engineOn("2027-03-01T15:00:00.000Z");
    events.append(ce.event); const b = engine.byCode("FNMA_A2101_TECH_PROVIDER_BREACH_5BD")[0]!; assert.equal(b.anchorDate, D("2027-03-01")); assert.equal(b.dueDate, D("2027-03-08")); assert.deepEqual(b.subject, { kind: "contract_events", id: ce.contract_event_id });
    clock.set("2027-03-03T15:00:00.000Z");
    events.append({ type: "fnma_notices.sent", aggregate: { kind: "contract_events", id: ce.contract_event_id }, actor: SYSTEM, payload: { kind: "a2101_copies_5bd", a2101_copies_5bd: true, document_id: "doc-copy-1" } }); assert.equal(b.status, "armed");
    events.append({ type: "fnma_notices.sent", aggregate: { kind: "contract_events", id: ce.contract_event_id }, actor: SYSTEM, payload: { kind: "a2101_event_5bd", a2101_event_5bd: true, document_id: null } }); assert.equal(b.status, "armed");
    // 19.3's fnma_notices.recordSent shape, as src/app/tools/section19-3.ts appends it
    events.append({ type: "fnma_notices.sent", aggregate: { kind: "contract_events", id: ce.contract_event_id }, actor: { kind: "human", id: "off-1", role: "officer" }, payload: { id: "fnma-notice-1", kind: "a2101_event_5bd", a2101_event_5bd: true, entity: "supermortgage", document_id: "doc-tech-2", copy_document_id: null, sent_by: "off-1", sent_on: D("2027-03-03"), contract_event_id: ce.contract_event_id, request_id: null } });
    assert.equal(b.status, "satisfied");
  }
  const tech = renderCorporateLetter("TECH-PROV-NOTICE-v1", { entity: "Partner Bank", kind: "planned_change", provider: "Supermortgage", loan_count: 24_600, planned_effective_on: D("2027-09-01") });
  assert.equal(tech.allowed, true); assert.match(tech.letter!.body, /gives this notice 180 days before the change/); assert.match(tech.letter!.citation, /A2-1-01/);
  assert.match(renderCorporateLetter("TECH-PROV-NOTICE-v1", { entity: "Partner Bank", kind: "planned_change", provider: "Supermortgage", loan_count: 24_600 }).refusal!, /missing planned_effective_on/);
  // FNMA_A42106_FORM183_ON_CHANGE: an "until" gate from the template publication, closed by the evidenced Form 183 submission for that version
  const f183 = reg.get("FNMA_A42106_FORM183_ON_CHANGE")!;
  assert.deepEqual(f183.offsetParsed, { kind: "until", condition: "form183.submitted" }); assert.equal(f183.satisfiedPattern!.type, "form183.submitted");
  const pub = noticeTemplatePublishedEvent({ template_code: "NTC_ADVERSE_ACTION", template_version: 3, notice_class: "adverse_action", published_on: D("2027-01-02") });
  assert.equal(pub.form183_required, true); assert.equal(pub.gate!.blocked_until, "form183.submitted"); assert.equal(eventMatches(f183.triggerPattern!, asEvent(pub.event)), true);
  const other = noticeTemplatePublishedEvent({ template_code: "NTC_PAYOFF", template_version: 2, notice_class: "other", published_on: D("2027-01-02") });
  assert.equal(other.gate, null); assert.equal(eventMatches(f183.triggerPattern!, asEvent(other.event)), false);
  {
    const { events, engine } = engineOn("2027-01-02T15:00:00.000Z");
    events.append(pub.event); const g = engine.byCode("FNMA_A42106_FORM183_ON_CHANGE")[0]!; assert.deepEqual(g.subject, { kind: "notice_template", id: "NTC_ADVERSE_ACTION" }); assert.equal(g.status, "armed");
    events.append(form183SubmittedEvent({ template_code: "NTC_ADVERSE_ACTION", template_version: 3, submission_evidence_document_id: "doc-183-1", submitted_on: D("2027-01-05") })!); assert.equal(g.status, "satisfied");
  }
  assert.equal(eventMatches(f183.satisfiedPattern!, asEvent(form183SubmittedEvent({ template_code: "NTC_ADVERSE_ACTION", template_version: 3, submission_evidence_document_id: "doc-183-1", submitted_on: D("2027-01-05") })!)), true);
  assert.equal(form183SubmittedEvent({ template_code: "NTC_ADVERSE_ACTION", template_version: 3, submission_evidence_document_id: null, submitted_on: D("2027-01-05") }), null);
  assert.equal(eventMatches(f183.satisfiedPattern!, asEvent({ type: "form183.submitted", payload: {} })), false);
  // rule 4: a new 5%+ owner is on both lists (prior approval + 60-day advance, and 5-BD Pending Actions after occurrence); guardrail: confidence 0.85 → officer decides within the 5-BD window
  const owner = classifyOrgChange({ kind: "owner_5pct", confidence: 0.95, occurred_on: D("2026-11-10") });
  assert.deepEqual(owner.classes, ["major_change_60d_advance", "pending_actions_5bd"]); assert.equal(owner.prior_approval_required, true); assert.equal(owner.decided_by, "agent");
  assert.deepEqual(classifyOrgChange({ kind: "principal_address", confidence: 0.95, occurred_on: D("2026-11-10") }).classes, ["major_change_60d_advance"]);
  const low = classifyOrgChange({ kind: "principal_officer", confidence: 0.85, occurred_on: D("2026-11-10") });
  assert.deepEqual(low.classes, ["pending_actions_5bd"]); assert.equal(low.decided_by, "officer"); assert.equal(low.escalation!.kind, "officer"); assert.equal(low.escalation!.due, D("2026-11-17")); assert.match(low.escalation!.reason, /0\.85 < 0\.9.*due 2026-11-18/);
  assert.equal(orgChangeRecorded({ entity: "supermortgage", kind: "principal_officer", occurred_on: D("2026-11-10"), confidence: 0.85 }).classification.decided_by, "officer");
});

test("18.4 tools: the Form 582 surface is defined for qc-audit, refuses an empty input with a typed reason (never a TypeError), the bus slice is exactly the registry's 18.4 names, and the guardrail sentences hold on the bus", async () => {
  const names = FORM582_TOOLS_18_4.map((t) => t.name);
  assert.equal(new Set(names).size, names.length); assert.ok(FORM582_TOOLS_18_4.every((t) => t.process === "18.4" && t.agent === "qc-audit"));
  for (const n of ["registry.query", "documents.retrieve", "insurance.calculate", "letter.render", "escalations.create", "human_portal_task.create", "filing.cycle.open", "filing.transition", "org_change.record", "org_change.plan", "org_change.gate.clear", "org_registry.write", "pending_actions.file", "regulatory_action.record", "notice.record_sent", "insurance_policy.record", "insurance_policy.renew", "insurance.expiry_check", "afs.receive", "partner.package.deliver", "tech_provider.contract_event.record", "tech_provider.change.declare", "notice_template.publish", "form183.submit", "notice.transition", "filing.late_check"]) assert.ok(names.includes(n), n);
  const specNames = new Set(loadAgentsFile().processes.find((p) => p.process === "18.4")!.tools);
  assert.deepEqual(TOOLS_18_4.map((t) => t.name).sort(), names.filter((n) => specNames.has(n)).sort());
  const b = bus18_4("2027-03-20T15:00:00.000Z");
  for (const t of FORM582_TOOLS_18_4) {
    try { await b.run(t.name, {}); }
    catch (e) { assert.ok(e instanceof RangeError || e instanceof CommandRefused, `${t.name}: ${(e as Error).stack}`); }
  }
  const refused = (name: string, input: Record<string, unknown>, code: string, actor?: Actor) => assert.rejects(b.run(name, input, actor), (e: Error) => e instanceof CommandRefused && e.code === code, `${name} → ${code}`);
  // "the agent cannot certify or submit": the renderer never signs; the portal task carries the officer's approval or is not created; Form 183 and the sent notice are human acts; a notice is recorded sent only with evidence
  await refused("letter.render", { template: "F582-PKG-v1", data: {}, sign: true }, "FORM582_LETTER_UNSIGNED");
  await b.run("filing.cycle.open", { entity: "partner", fye: "2026-12-31" });
  await refused("human_portal_task.create", { filing_id: "f-582-partner-2026-12-31", answer_sheet_document_id: "doc-sheet-1", evidence_index_document_id: "doc-idx-1" }, "FORM582_PORTAL_TASK_NEEDS_APPROVAL");
  b.rt.store.put("regulatory_filings", "f-582-partner-2026-12-31", { status: "officer_review", approved_by_officer_id: "off-partner-1" }, OFFICER, b.clock.now());
  const task = await b.run("human_portal_task.create", { filing_id: "f-582-partner-2026-12-31", answer_sheet_document_id: "doc-sheet-1", evidence_index_document_id: "doc-idx-1" }) as { assignee_role: string; owner_role: string; approved_by_officer_id: string; due_at: string };
  assert.equal(task.assignee_role, "partner_designated_submitter"); assert.equal(task.approved_by_officer_id, "off-partner-1"); assert.equal(task.due_at, D("2027-03-31")); assert.equal(task.owner_role, "fnma_portal_operator");
  await refused("form183.submit", { template_code: "NTC_ADVERSE_ACTION", template_version: 3, submission_evidence_document_id: "doc-183-1" }, "FORM183_HUMAN_ACT");
  await refused("notice.record_sent", { notice: "partner", send: true, evidence_document_id: "doc-1", subject_kind: "org_change", subject_id: "x", event_kind: "k" }, "FNMA_NOTICE_OFFICER_SENDS");
  await refused("notice.record_sent", { notice: "partner", subject_kind: "org_change", subject_id: "x", event_kind: "k" }, "FNMA_NOTICE_SENT_EVIDENCE");
  // "any unresolved consistency check blocks officer_review": an unresolved check, or a policy below the A3-5-02 requirement (18.4-T3), refuses the transition; resolved and adequate it goes through
  await b.run("filing.cycle.open", { entity: "supermortgage", fye: "2026-12-31" });
  const sm = "f-582-supermortgage-2026-12-31";
  b.rt.store.put("regulatory_filings", sm, { status: "registry_verified" }, OFFICER, b.clock.now());
  const checks = CONSISTENCY_CHECKS.map((code) => ({ code, resolved: true }));
  await refused("filing.transition", { filing_id: sm, to: "officer_review", checks: [...checks.filter((c) => c.code !== "licenses_match_nmls"), { code: "licenses_match_nmls", resolved: false, detail: "NMLS renewal pending" }] }, "FORM582_OFFICER_REVIEW_BLOCKED");
  await refused("filing.transition", { filing_id: sm, to: "officer_review", checks, insurance: { policy_fidelity_cents: "500000000", policy_eo_cents: "552500000", highest_monthly_servicing_upb_cents: "500000000000" } }, "FORM582_OFFICER_REVIEW_BLOCKED");
  assert.equal(b.rt.store.get("regulatory_filings", sm)!.data.status, "registry_verified");
  assert.deepEqual(await b.run("filing.transition", { filing_id: sm, to: "officer_review", checks, insurance: { policy_fidelity_cents: "552500000", policy_eo_cents: "552500000", highest_monthly_servicing_upb_cents: "500000000000" } }), { filing_id: sm, status: "officer_review" });
  // "org-change classification with confidence < 0.9 → officer decides within the 5-BD window": the agent records and escalates, it does not decide; the officer may
  await refused("org_change.record", { entity: "supermortgage", kind: "principal_officer", occurred_on: "2026-11-10", confidence: 0.85, decide: true }, "ORG_CHANGE_LOW_CONFIDENCE_OFFICER_DECIDES");
  const low = await b.run("org_change.record", { entity: "supermortgage", kind: "principal_officer", occurred_on: "2026-11-10", confidence: 0.85 }) as { org_change_id: string; classification: { decided_by: string }; escalations: string[]; timer: { due: string } };
  assert.equal(low.classification.decided_by, "officer"); assert.equal(low.escalations.length, 1); assert.equal(low.timer.due, D("2026-11-18"));
  assert.equal(b.ctx.timers.byCode("FNMA_A4102_ORG_CHANGE_5BD").length, 1); assert.equal(b.ctx.timers.byCode("SM_PARTNER_NOTIFY_SUB_EVENT_1BD").length, 1);
  assert.equal((await b.run("org_change.record", { entity: "supermortgage", kind: "principal_officer", occurred_on: "2026-11-10", confidence: 0.85, decide: true }, OFFICER) as { idempotent?: boolean }).idempotent, true);
  // A4-1-03 breach action on the bus (18.4-T5): the planned 10% sale blocks the partner's owner row until the officer waives with rationale or Fannie Mae's approval is recorded — never an agent, never without the document or the rationale
  const plan = await b.run("org_change.plan", { entity: "partner", kind: "owner_5pct", planned_effective_on: "2027-05-01", recorded_on: "2027-03-20", ownership_pct_bps: 1000 }) as { org_change_id: string; gate: { blocked: boolean; already_passed: boolean }; escalations: string[] };
  assert.equal(plan.gate.blocked, true); assert.equal(plan.gate.already_passed, true); assert.equal(plan.escalations.length, 2);
  const gate = b.ctx.timers.byCode("FNMA_A4103_MAJOR_CHANGE_ADVANCE_60")[0]!; assert.equal(gate.dueDate, D("2027-03-02"));
  const ownerRow = { entity: "partner", write: { record: "org_registry", role: "owner", ownership_pct_bps: 1000, effective_from: "2027-05-01" } };
  await refused("org_registry.write", ownerRow, "ORG_CHANGE_GATE_BLOCKED");
  await refused("org_change.gate.clear", { org_change_id: plan.org_change_id, by: "officer_waiver", document_id: "doc-waiver-1", rationale: "late discovery; Fannie Mae notified with explanation" }, "ORG_CHANGE_WAIVER_OFFICER");
  await refused("org_change.gate.clear", { org_change_id: plan.org_change_id, by: "officer_waiver", document_id: "doc-waiver-1" }, "ORG_CHANGE_WAIVER_RATIONALE", OFFICER);
  await refused("org_change.gate.clear", { org_change_id: plan.org_change_id, by: "officer_waiver", rationale: "late discovery" }, "ORG_CHANGE_CLEARANCE_DOCUMENT", OFFICER);
  await refused("org_change.gate.clear", { org_change_id: plan.org_change_id, by: "agent_override", document_id: "doc-x" }, "ORG_CHANGE_CLEARANCE_BY");
  await assert.rejects(b.run("org_change.gate.clear", { org_change_id: plan.org_change_id, by: "fnma_approval", document_id: "doc-fnma-approval-1" }), RangeError);   // an approval needs its reference
  assert.equal(b.ctx.timers.byCode("FNMA_A4103_MAJOR_CHANGE_ADVANCE_60")[0]!.status, "armed");
  const cleared = await b.run("org_change.gate.clear", { org_change_id: plan.org_change_id, by: "officer_waiver", document_id: "doc-waiver-1", rationale: "investor crossed 5% via secondary purchase; Fannie Mae notified 2027-03-20 with explanation" }, OFFICER) as { blocked: boolean; cleared: { by: string; officer_id: string } };
  assert.equal(cleared.blocked, false); assert.equal(cleared.cleared.by, "officer_waiver"); assert.equal(cleared.cleared.officer_id, "off-1"); assert.equal(gate.status, "satisfied");
  assert.equal((await b.run("org_registry.write", ownerRow) as { role: string }).role, "owner");
  // the annual cycle end to end on the bus: partner package with receipt, the auditor's AFS, the partner's submitter
  assert.equal(b.ctx.timers.byCode("SM_FORM582_PARTNER_PACKAGE_FYE_60")[0]!.dueDate, D("2027-03-01"));
  assert.ok(b.ctx.timers.evaluate(b.clock.now()).some((x) => x.def.code === "SM_FORM582_PARTNER_PACKAGE_FYE_60"));   // 03-20: the day-60 package clock and the day-75 auditor clock have breached
  await assert.rejects(b.run("partner.package.deliver", { fye: "2026-12-31", package_document_id: "doc-pkg-1" }), RangeError);
  await b.run("partner.package.deliver", { fye: "2026-12-31", package_document_id: "doc-pkg-1", receipt_document_id: "doc-receipt-1" });
  assert.equal(b.ctx.timers.byCode("SM_FORM582_PARTNER_PACKAGE_FYE_60")[0]!.status, "satisfied_late");
  await b.run("afs.receive", { entity: "supermortgage", fye: "2026-12-31", auditor: "Auditor LLP", document_id: "doc-afs-1", audit_opinion: true });
  assert.equal(b.ctx.timers.byCode("SM_AFS_AUDITOR_DELIVERY_FYE_75").find((t) => t.subject.id === "supermortgage:2026-12-31")!.status, "satisfied_late"); assert.equal(b.rt.store.get("regulatory_filings", "f-afs-supermortgage-2026-12-31")!.data.package_document_id, "doc-afs-1");
  await refused("filing.transition", { filing_id: "f-582-partner-2026-12-31", to: "submitted", ecrm_confirmation_document_id: "doc-ecrm-p-1" }, "NOT_DESIGNATED_SUBMITTER", SUBMITTER);
  await b.run("filing.transition", { filing_id: "f-582-partner-2026-12-31", to: "submitted", ecrm_confirmation_document_id: "doc-ecrm-p-1" }, PARTNER_SUBMITTER);
  assert.equal(b.ctx.timers.byCode("FNMA_A4102_FORM582_FYE_90").find((t) => t.subject.id === "partner:2026-12-31")!.status, "satisfied");
  // the notice state machine as regulatory_filings rows (state machine: detected → classified → drafted → officer_approved → filed → acknowledged; Outputs: "regulatory_filings rows with submission evidence"): a consent order received Fri 2027-03-19 opens an org_change_notice row drafted the same day, due Mon 03-22 on the 1-BD proxy
  const ra = await b.run("regulatory_action.record", { entity: "supermortgage", kind: "state_consent_order", regulator: "NY DFS", received_on: "2027-03-19", document_id: "doc-co-1" }) as { regulatory_action_id: string; notice_id: string; timer: { due: string } };
  assert.equal(ra.notice_id, `notice-${ra.regulatory_action_id}`); assert.equal(ra.timer.due, D("2027-03-22"));
  const noticeRow = () => b.rt.store.get("regulatory_filings", ra.notice_id)!.data;
  assert.deepEqual([noticeRow().filing_type, noticeRow().status, noticeRow().due_at, noticeRow().template, noticeRow().late, noticeRow().approved_by_officer_id], ["org_change_notice", "drafted", D("2027-03-22"), "ORG-CHG-NOTICE-v1", false, null]);
  assert.deepEqual(b.ctx.events.ofType("filing.status.changed").filter((e) => e.payload.filing_id === ra.notice_id).map((e) => [e.payload.from, e.payload.to]), [["classified", "drafted"]]);
  const raClock = b.ctx.timers.byCode("FNMA_A4103_REGULATORY_ACTION_IMMEDIATE").find((t) => t.subject.id === ra.regulatory_action_id)!; assert.equal(raClock.dueDate, D("2027-03-22"));
  // the agent cannot approve it, nor record a send the officer never approved; the row and the regulatory_actions row are untouched and the clock stays armed
  await refused("notice.transition", { notice_id: ra.notice_id, to: "officer_approved" }, "NOTICE_OFFICER_APPROVES");
  await refused("notice.record_sent", { notice: "regulatory_action", regulatory_action_id: ra.regulatory_action_id, evidence_document_id: "doc-sent-1", sent_by: "off-1" }, "NOTICE_NOT_OFFICER_APPROVED");
  await refused("notice.transition", { notice_id: ra.notice_id, to: "acknowledged" }, "NOTICE_ACKNOWLEDGMENT_REQUIRED", OFFICER);
  await refused("notice.transition", { notice_id: ra.notice_id, to: "filed" }, "NOTICE_FILED_EVIDENCE_REQUIRED", OFFICER);
  await refused("notice.transition", { notice_id: ra.notice_id, to: "acknowledged", acknowledgment_document_id: "doc-ack-1" }, "NOTICE_INVALID_TRANSITION", OFFICER);
  assert.equal(noticeRow().status, "drafted"); assert.equal(b.rt.store.get("regulatory_actions", ra.regulatory_action_id)!.data.status, "drafted"); assert.equal(raClock.status, "armed");
  // the officer approves; the agent's record of the sent evidence files it — the regulatory_actions row says filed (the spec's state, never 'sent'), the clock closes, and the notice carries its submission evidence
  assert.deepEqual(await b.run("notice.transition", { notice_id: ra.notice_id, to: "officer_approved" }, OFFICER), { notice_id: ra.notice_id, status: "officer_approved", steps: ["officer_approved"], approved_by_officer_id: "off-1", submission_evidence: null, late: false });
  const sent = await b.run("notice.record_sent", { notice: "regulatory_action", regulatory_action_id: ra.regulatory_action_id, evidence_document_id: "doc-sent-1", sent_by: "off-1" }) as { notice: { id: string; status: string; steps: string[]; late: boolean } };
  assert.deepEqual(sent.notice, { id: ra.notice_id, status: "filed", steps: ["filed"], late: false });
  assert.deepEqual([noticeRow().status, noticeRow().submission_evidence, noticeRow().submitted_at, noticeRow().late], ["filed", "doc-sent-1", b.clock.now(), false]);
  assert.equal(b.rt.store.get("regulatory_actions", ra.regulatory_action_id)!.data.status, "filed"); assert.equal(raClock.status, "satisfied");
  assert.deepEqual(await b.run("notice.transition", { notice_id: ra.notice_id, to: "acknowledged", acknowledgment_document_id: "doc-ack-1" }, OFFICER), { notice_id: ra.notice_id, status: "acknowledged", steps: ["acknowledged"], approved_by_officer_id: "off-1", submission_evidence: "doc-sent-1", late: false });
  assert.equal(noticeRow().acknowledgment_document_id, "doc-ack-1");
  // a technology-contract termination opens a tech_provider_notice row; the officer's own send is the approval (drafted → officer_approved → filed in one act) and closes the A2-1-01 clock
  const ce = await b.run("tech_provider.contract_event.record", { entity: "supermortgage", contract_id: "c-printmail-1", provider: "print-mail-vendor", kind: "termination", occurred_on: "2027-03-18", loan_count: 24_600 }) as { contract_event_id: string; notice_id: string };
  assert.equal(b.rt.store.get("regulatory_filings", ce.notice_id)!.data.filing_type, "tech_provider_notice"); assert.equal(b.rt.store.get("regulatory_filings", ce.notice_id)!.data.status, "drafted");
  const techClock = b.ctx.timers.byCode("FNMA_A2101_TECH_PROVIDER_BREACH_5BD").find((t) => t.subject.id === ce.contract_event_id)!; assert.equal(techClock.anchorDate, D("2027-03-18")); assert.equal(techClock.dueDate, D("2027-03-25"));
  const officerSent = await b.run("notice.record_sent", { notice: "tech_provider_event", entity: "supermortgage", contract_event_id: ce.contract_event_id, kind: "termination", provider: "print-mail-vendor", loan_count: 24_600, evidence_document_id: "doc-tech-sent-1" }, OFFICER) as { notice: { status: string; steps: string[] } };
  assert.deepEqual(officerSent.notice, { id: ce.notice_id, status: "filed", steps: ["officer_approved", "filed"], late: false }); assert.equal(b.rt.store.get("regulatory_filings", ce.notice_id)!.data.approved_by_officer_id, "off-1"); assert.equal(techClock.status, "satisfied");
  // the A4-1-03 planned sale's notice row (opened drafted by org_change.plan, already late: needed by 03-02, recorded 03-20) is filed by the officer's sent letter and acknowledged by Fannie Mae's approval through org_change.gate.clear
  const planNotice = b.rt.store.get("regulatory_filings", `notice-${plan.org_change_id}`)!.data;
  assert.deepEqual([planNotice.filing_type, planNotice.status, planNotice.due_at, planNotice.late, planNotice.notice_kind], ["org_change_notice", "drafted", D("2027-03-02"), true, "prior_approval_request"]);
  await b.run("notice.record_sent", { notice: "org_change", org_change_id: plan.org_change_id, evidence_document_id: "doc-prior-approval-request-1" }, OFFICER);
  assert.deepEqual([b.rt.store.get("regulatory_filings", `notice-${plan.org_change_id}`)!.data.status, b.rt.store.get("regulatory_filings", `notice-${plan.org_change_id}`)!.data.late], ["filed", true]);
  assert.equal((await b.run("org_change.gate.clear", { org_change_id: plan.org_change_id, by: "fnma_approval", document_id: "doc-fnma-approval-1", fnma_reference: "Fannie Mae approval letter 2027-03-25" }) as { notice_acknowledged: boolean }).notice_acknowledged, true);
  assert.equal(b.rt.store.get("regulatory_filings", `notice-${plan.org_change_id}`)!.data.status, "acknowledged");
  // the Pending Actions notice row of the low-confidence CFO change opened `detected` (the officer decides the classification); filing it as the agent before the officer's approval is refused
  assert.equal(b.rt.store.get("regulatory_filings", `notice-${low.org_change_id}`)!.data.status, "detected");
  await refused("pending_actions.file", { org_change_id: low.org_change_id, form582_updated_at: "2027-03-20T14:00:00Z", pending_actions_document_id: "doc-582-pa-1", email_sent_at: "2027-03-20T14:05:00Z", email_evidence_document_id: "doc-mail-1" }, "NOTICE_INVALID_TRANSITION");
  // the `late` flag when past due_at: the sweep on 2027-04-01 flags every open row whose due_at (03-31) has passed — the supermortgage AFS row and the officer_review Form 582 — never the partner's submitted Form 582 or a row still within its window
  assert.equal(lateFlag(D("2027-03-31"), null, D("2027-03-31")), false); assert.equal(lateFlag(D("2027-03-31"), null, D("2027-04-01")), true); assert.equal(lateFlag(D("2027-03-31"), D("2027-04-01"), D("2027-04-01")), true);
  assert.deepEqual(await b.run("filing.late_check", { as_of: "2027-03-31" }), { as_of: D("2027-03-31"), flagged: [] });
  const swept = await b.run("filing.late_check", { as_of: "2027-04-01" }) as { flagged: string[] };
  assert.deepEqual(swept.flagged.sort(), ["f-582-supermortgage-2026-12-31", "f-afs-partner-2026-12-31", "f-afs-supermortgage-2026-12-31"]);
  assert.equal(b.rt.store.get("regulatory_filings", "f-afs-supermortgage-2026-12-31")!.data.late, true); assert.equal(b.rt.store.get("regulatory_filings", "f-582-partner-2026-12-31")!.data.late, false);
  assert.deepEqual((await b.run("filing.late_check", { as_of: "2027-04-02" }) as { flagged: string[] }).flagged, []);   // idempotent: already flagged rows are not flagged again
  assert.equal(b.ctx.events.ofType("filing.late_flagged").length, 3);
  // the state machine directly: every step in order, the officer's send from drafted, and nothing the agent can approve
  const row = noticeFilingOpen({ subject: { kind: "org_change", id: "supermortgage:principal_officer:2026-11-10" }, entity: "supermortgage", filing_type: "org_change_notice", template: "F582-PENDING-v1", notice_kind: "principal_officer", due_at: D("2026-11-18"), opened_on: D("2026-11-10"), status: "detected" });
  assert.equal(row.id, "notice-supermortgage:principal_officer:2026-11-10"); assert.equal(row.late, false); assert.deepEqual(NOTICE_STATES, ["detected", "classified", "drafted", "officer_approved", "filed", "acknowledged"]);
  const at = (r: typeof row, to: (typeof NOTICE_STATES)[number], actor: Actor, extra: Record<string, string> = {}) => noticeTransition({ row: r, to, actor, now: "2026-11-16T14:05:00Z", on: D("2026-11-16"), ...extra });
  assert.deepEqual(at(row, "drafted", AGENT).refusal_codes, ["NOTICE_INVALID_TRANSITION"]);
  const classified = at(row, "classified", AGENT); assert.equal(classified.allowed, true); assert.deepEqual(classified.steps, ["classified"]); assert.equal(classified.event!.type, "filing.status.changed"); assert.deepEqual(classified.event!.aggregate, row.subject);
  const drafted = at(classified.row, "drafted", AGENT, { document_id: "doc-draft-1" }).row; assert.equal(drafted.package_document_id, "doc-draft-1");
  assert.deepEqual(at(drafted, "officer_approved", AGENT).refusal_codes, ["NOTICE_OFFICER_APPROVES"]); assert.deepEqual(at(drafted, "filed", AGENT, { submission_evidence: "doc-582-pa-1; doc-mail-1" }).refusal_codes, ["NOTICE_NOT_OFFICER_APPROVED"]);
  assert.deepEqual(at(drafted, "filed", OFFICER).refusal_codes, ["NOTICE_FILED_EVIDENCE_REQUIRED"]);
  const approved = at(drafted, "officer_approved", OFFICER).row; assert.equal(approved.approved_by_officer_id, "off-1");
  const filed = at(approved, "filed", AGENT, { submission_evidence: "doc-582-pa-1; doc-mail-1" }); assert.equal(filed.allowed, true); assert.deepEqual([filed.row.status, filed.row.submission_evidence, filed.row.submitted_at, filed.row.late], ["filed", "doc-582-pa-1; doc-mail-1", "2026-11-16T14:05:00Z", false]);
  assert.equal(noticeTransition({ row: approved, to: "filed", actor: AGENT, now: "2026-11-19T14:05:00Z", on: D("2026-11-19"), submission_evidence: "doc-582-pa-1; doc-mail-1" }).row.late, true);   // filed 11-19, past the 11-18 due_at
  const viaOfficer = at(drafted, "filed", OFFICER, { submission_evidence: "doc-582-pa-1; doc-mail-1" }); assert.deepEqual(viaOfficer.steps, ["officer_approved", "filed"]); assert.equal(viaOfficer.row.approved_by_officer_id, "off-1");
  assert.deepEqual(at(filed.row, "acknowledged", AGENT).refusal_codes, ["NOTICE_ACKNOWLEDGMENT_REQUIRED"]); assert.equal(at(filed.row, "acknowledged", AGENT, { acknowledgment_document_id: "doc-ack-1" }).row.status, "acknowledged");
  // every act left a decision row; the reads did not
  assert.ok(b.ctx.decisions.length >= 8); assert.deepEqual(await b.run("registry.query", { registry: "insurance_policies" }), []);
});
