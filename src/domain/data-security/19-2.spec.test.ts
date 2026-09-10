// 19.2 GLBA safeguards
// spec/sections/19-data-security-recordkeeping/19-2-glba-safeguards.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, wallClock } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { TOOLS_19_2 } from "../../app/tools/section19-2.ts";
import { triageIncident, severityChange, identifiedAtFor, irRunbook, scopeIncident, stateBreachClocks, stateRegulatorRecipients, stateRegulatorNoticesComplete, consumerNoticesMailed, ftcOfficerTask, incidentNoticeSent, sentinelReport, postIncidentAssessmentClocks, vulnRemediationDueMs, vulnerabilityDetected, credentialResetClock, backupRestoreTest, nydfsAnnualPackage, containmentAction, restrictedPromptFields, mfaControlTest, tlsControlTest, exceptionProposal, type TriageInput, type AffectedPerson } from "./ops-19-2.ts";
import { timerBreached, nydfsClocks, extortionClocks } from "./incident.ts";
import { applyDataSecurityTimerOverrides } from "./timers.ts";
import { EVALUATORS_19_2 } from "./evaluators-19-2.ts";
import { VERSIONS_19_2 } from "../../notices/authored/section19-2.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";

const ET = "America/New_York";
const H = 3_600_000, MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const CONFIRMED = zonedEpochMs(D("2026-10-16"), "14:30", ET);   // the spec's worked timeline: SOC confirms Fri 2026-10-16 14:30 ET
const INC = "INC-2026-0042";
const BEC: TriageInput = { category: "bec", confirmed_exposure: false, ransomware_deployed: false, material_ops_harm: false, reasonable_conclusion: false, data_impact: false, contained_event: true, confirmed_ms: CONFIRMED, fnma_application_data: false, incident_id: INC };
/** The worked timeline's S2: the SOC's reasonable conclusion that a vendor SFTP credential was abused (data impact; Fannie Mae application Data involved). */
const S2: TriageInput = { ...BEC, category: "credential_compromise", reasonable_conclusion: true, data_impact: true, fnma_application_data: true };
const AGENT: Actor = { kind: "agent", id: "security-records" };
const CISO: Actor = { kind: "human", id: "u-ciso", role: "ciso" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const SCANNER: Actor = { kind: "system", id: "vuln-scanner" };
const persons = (n: number, state: string, encrypted = false, keyPresumed = false, prefix = state.toLowerCase()): AffectedPerson[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, state, encrypted, key_compromised_or_presumed: keyPresumed }));
/** 12,400 borrowers on the vendor side, files unencrypted at rest: 3,100 NY, 2,000 TX, the rest NY-adjacent states with a matrix row (TX) — the spec's worked scope without an unmatrixed state. */
const WORKED = [...persons(3_100, "NY"), ...persons(9_300, "TX")];
const notices = (() => { const r = buildRegistry(); publishAuthored(r); return r; })();
const version = (code: string) => notices.activeVersion(code, D("2026-09-01"))!;
const checklist = (code: string, payload: Record<string, unknown>) => { const v = version(code); return evaluateChecklist(v, payload, render(v.source, payload)); };

/** The platform the console and the agent share: the 19.2 registry rows (section overrides applied), the bus with every 19.2 tool bound for its agent, the entity store and the escalation queue. */
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const reg = loadRegistry(); applyDataSecurityTimerOverrides(reg);
  const timers = new TimerEngine(reg, events, { processes: ["19.2"] });
  const ctx: UowContext = { loanId: "", events, ledger: new MemoryLedger(), timers, clock, decide: () => {} };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const bus = new CommandBus(agents);
  const cmds = new Map(TOOLS_19_2.map((d) => { const c = toolCommand(d, rt, ["officer", "attorney", "ciso"]); agents.registerTool(d.agent, c.name); return [d.name, c] as const; }));
  const run = (name: string, actor: Actor, input: Record<string, unknown>) => bus.execute(cmds.get(name)!, actor, input, ctx);
  const armed = (code: string) => timers.all().filter((t) => t.code === code);
  const identify = (id: string, input: TriageInput, actor: Actor = AGENT) => run("incident.setSeverity", actor, { incident_id: id, confirmed_at: iso(input.confirmed_ms), category: input.category, confirmed_exposure: input.confirmed_exposure, ransomware_deployed: input.ransomware_deployed, material_ops_harm: input.material_ops_harm, reasonable_conclusion: input.reasonable_conclusion, data_impact: input.data_impact, contained_event: input.contained_event, fnma_application_data: input.fnma_application_data });
  return { clock, events, reg, timers, ctx, rt, run, armed, identify };
}

test("19.2-T1: Given `security.incident.identified` at Fri 2026-10-16 14:30 ET (S2), then `FNMA_SUPP_INCIDENT_NOTICE_36H` is due Sun 2026-10-18 02:30 ET, the partner timer Sat 14:30 ET, and warnings fire at 50/75/90 % elapsed.", async () => {
  const t = triageIncident(S2);
  assert.equal(t.severity, "S2"); assert.equal(t.identified_at_ms, CONFIRMED, "identification is the SOC's confirmation");
  const at = (code: string) => { const c = wallClock(t.timers.find((x) => x.code === code)!.due_ms, ET); return [c.date, c.hour, c.minute]; };
  assert.deepEqual(at("FNMA_SUPP_INCIDENT_NOTICE_36H"), [D("2026-10-18"), 2, 30], "36 clock hours → Sun 02:30 ET");
  assert.deepEqual(at("SM_PARTNER_INCIDENT_NOTICE_24H"), [D("2026-10-17"), 14, 30], "24 h → Sat 14:30 ET");
  // warnings at 50 / 75 / 90 % of the 36-hour clock: 18 h → Sat 08:30, 27 h → Sat 17:30, 32 h 24 m → Sat 22:54 ET
  assert.deepEqual(t.warnings.map((w) => { const c = wallClock(w.at_ms, ET); return [w.pct, c.date, c.hour, c.minute]; }), [[50, D("2026-10-17"), 8, 30], [75, D("2026-10-17"), 17, 30], [90, D("2026-10-17"), 22, 54]]);
  assert.equal(t.event?.type, "security.incident.identified"); assert.equal(t.event?.occurredAt, iso(CONFIRMED)); assert.equal(t.event?.payload.identified_at, iso(CONFIRMED));
  // on the bus: the agent records the confirmation at 16:00 ET, but the registry rows anchor on the SOC's 14:30 confirmation (rule 1)
  const h = harness("2026-10-16T20:00:00.000Z");
  const out = await h.identify(INC, S2);
  assert.equal((out.output as { identified_at: string }).identified_at, iso(CONFIRMED));
  const due = (code: string) => { const a = h.armed(code); assert.equal(a.length, 1, `${code} armed once`); return a[0]!.dueAt; };
  assert.equal(due("FNMA_SUPP_INCIDENT_NOTICE_36H"), zonedEpochMs(D("2026-10-18"), "02:30", ET));
  assert.equal(due("SM_PARTNER_INCIDENT_NOTICE_24H"), zonedEpochMs(D("2026-10-17"), "14:30", ET));
  assert.equal(due("FNMA_FORM101_DATA_INCIDENT_NOTICE_36H"), zonedEpochMs(D("2026-10-18"), "02:30", ET));
  assert.equal(due("SM_NYDFS_DETERMINATION_48H"), zonedEpochMs(D("2026-10-18"), "14:30", ET));
  assert.equal(h.armed("FNMA_SUPP_POST_INCIDENT_ASSESSMENT").length, 0, "S2 arms no post-incident assessment");
  assert.equal(h.armed("FNMA_SUPP_LOST_MEDIA_NOTICE_36H").length, 0);
  // breach column: sev-1 → officer + CISO page at 50/75/90 % elapsed; Compliance Sentinel
  const def = h.reg.get("FNMA_SUPP_INCIDENT_NOTICE_36H")!; assert.equal(def.severity.level, 1); assert.ok(def.severity.escalateTo.includes("officer")); assert.match(def.breach, /50%\/75%\/90% elapsed; Compliance Sentinel/);
  assert.ok(h.rt.escalations.opened.some((e) => e.kind === "officer"), "the officer sends the notices from the agent's draft");
  // rule 1: identification can never be postponed — not by a supplied identified_at, not by a later confirmation record
  await assert.rejects(h.identify(INC, { ...S2, confirmed_ms: CONFIRMED + 1 * H }).then(() => h.run("incident.setSeverity", AGENT, { incident_id: INC, severity: "S2", identified_at: "2026-10-17T00:00:00.000Z" })), (e: unknown) => e instanceof CommandRefused && e.code === "IDENTIFIED_AT_IMMUTABLE");
  assert.equal(h.rt.store.get("security_incidents", INC)!.data.identified_at, iso(CONFIRMED));
  assert.deepEqual(identifiedAtFor(CONFIRMED, CONFIRMED + 1 * H, CONFIRMED + 2 * H), { identified_ms: CONFIRMED, refusal: null }, "a later SOC record never moves identification");
  assert.match(identifiedAtFor(null, CONFIRMED + 5 * H, CONFIRMED).refusal!, /cannot be in the future/);
});
test("19.2-T2: Given a Fannie Mae notice sent Sun 2026-10-18 03:00 ET, then the timer is `breached` even though the notice was sent and the breach appears in the Sentinel report.", async () => {
  const h = harness(iso(CONFIRMED));
  await h.identify(INC, { ...S2, fnma_application_data: false });
  const fnma = h.armed("FNMA_SUPP_INCIDENT_NOTICE_36H")[0]!, partner = h.armed("SM_PARTNER_INCIDENT_NOTICE_24H")[0]!;
  // the partner notice goes Sat 09:00 ET, inside its clock
  const sat = zonedEpochMs(D("2026-10-17"), "09:00", ET);
  h.events.append({ ...incidentNoticeSent({ incident_id: INC, recipient: "partner", template_code: "NTC_PARTNER_INCIDENT_24H", sent_ms: sat, sent_by_role: "officer", channel: "email" }).event, actor: OFFICER });
  assert.equal(partner.status, "satisfied");
  // the Fannie Mae clock passes Sun 02:30 ET; the Sentinel sweep at 02:31 breaches it (sev-1 → officer)
  h.clock.set(iso(zonedEpochMs(D("2026-10-18"), "02:31", ET)));
  const breaches = h.timers.evaluate(h.clock.now());
  assert.deepEqual(breaches.map((b) => [b.instance.code, b.severity, b.escalateTo.includes("officer")]), [["FNMA_SUPP_INCIDENT_NOTICE_36H", 1, true]]);
  assert.equal(fnma.status, "breached");
  // the officer sends at Sun 03:00 ET: the notice closes the timer late — it stays a breach and the Sentinel report carries it
  const sentMs = zonedEpochMs(D("2026-10-18"), "03:00", ET);
  const sent = incidentNoticeSent({ incident_id: INC, recipient: "fannie_mae_supplement", template_code: "NTC_FNMA_INCIDENT_36H", sent_ms: sentMs, sent_by_role: "officer", channel: "email", evidence_document_id: "doc-ack-1" });
  assert.equal(sent.refusal, null); assert.equal(sent.row.recipient, "fannie_mae_supplement");
  h.events.append({ ...sent.event, actor: OFFICER });
  assert.equal(fnma.status, "satisfied_late"); assert.equal(fnma.satisfiedAt, iso(sentMs));
  assert.ok(timerBreached(fnma.dueAt!, sentMs));
  assert.deepEqual(sentinelReport(h.timers.all()).breaches.map((b) => [b.code, b.status, b.late_by_minutes]), [["FNMA_SUPP_INCIDENT_NOTICE_36H", "satisfied_late", 30]]);
  assert.ok(h.events.ofType("timer.breached").some((e) => e.payload.code === "FNMA_SUPP_INCIDENT_NOTICE_36H"));
  // an on-time send would not appear; a non-officer cannot send at all
  assert.equal(sentinelReport([{ code: "X", status: "satisfied", dueAt: 10, satisfiedAt: iso(5) }]).breaches.length, 0);
  assert.match(incidentNoticeSent({ incident_id: INC, recipient: "fannie_mae_supplement", template_code: "NTC_FNMA_INCIDENT_36H", sent_ms: sentMs, sent_by_role: "ops_analyst", channel: "email" }).refusal!, /sent by an officer/);
  // the notice's own checklist would have flagged the 36.5-hour send
  const v = version("NTC_FNMA_INCIDENT_36H"); const late = { ...v.samplePayload, hours_since_identification: 36.5 };
  assert.ok(evaluateChecklist(v, late, render(v.source, late)).blocking.some((r) => r.rule_id === "36h"));
});
test("19.2-T3: Given scoping shows 12,400 consumers with unencrypted data acquired (presumed), then the FTC timer is created with due 2026-11-15 and an `officer` task with the six content elements prefilled.", async () => {
  const scopedMs = zonedEpochMs(D("2026-10-19"), "10:00", ET);
  const presumed = [...persons(3_100, "NY", true, true), ...persons(9_300, "TX", true, true)];   // encrypted files whose key is presumed compromised → "presumed" acquisition (rule 2)
  const s = scopeIncident({ discovered_on: D("2026-10-16"), persons: presumed, scoped_ms: scopedMs, incident_id: INC });
  assert.equal(s.consumer_count, 12_400); assert.equal(s.unencrypted_customer_info_acquired, "presumed");
  assert.deepEqual([s.ftc.required, s.ftc.due, s.ftc.internal_target, s.ftc.timer?.code], [true, D("2026-11-15"), D("2026-11-13"), "FTC_314_4J_NOTIFICATION_EVENT_30D"]);
  assert.equal(s.event.payload.discovered_at, D("2026-10-16")); assert.equal(s.event.payload.consumer_count, 12_400);
  const details = { institution_name: "Supermortgage", institution_contact: "A. Lead, CISO, security@supermortgage.example", information_types: "names, addresses, loan numbers, payment amounts", date_range: "October 14–16, 2026", description: "vendor SFTP credential abuse; statement files downloaded", law_enforcement_delay: false };
  const task = ftcOfficerTask(s, details)!;
  assert.deepEqual([task.kind, task.owner_role, task.portal, task.timer_code, task.due, task.internal_target, task.template_code], ["human_portal_task", "officer", "ftc_safeguards_notification_form", "FTC_314_4J_NOTIFICATION_EVENT_30D", D("2026-11-15"), D("2026-11-13"), "NTC_FTC_314_4J"]);
  const SIX = ["element_1_name_contact", "element_2_information_types", "element_3_date_range", "element_4_consumer_count", "element_5_description", "element_6_law_enforcement"];
  assert.deepEqual(Object.keys(task.prefilled), SIX); assert.equal(task.prefilled.element_4_consumer_count, 12_400); assert.match(String(task.prefilled.element_6_law_enforcement), /^no law enforcement official/);
  assert.equal(ftcOfficerTask(scopeIncident({ discovered_on: D("2026-10-16"), persons: persons(480, "NY") }), details), null);
  // on the bus: incident.scope arms the FTC row (30 calendar days from discovered_at) and opens the officer's portal task with the six elements prefilled
  const h = harness(iso(scopedMs));
  await h.run("incident.scope", AGENT, { incident_id: INC, discovered_on: "2026-10-16", persons: presumed, ...details });
  const ftc = h.armed("FTC_314_4J_NOTIFICATION_EVENT_30D"); assert.equal(ftc.length, 1);
  assert.equal(ftc[0]!.anchorDate, D("2026-10-16")); assert.equal(ftc[0]!.dueDate, D("2026-11-15"));
  const esc = h.rt.escalations.opened.find((e) => e.kind === "human_portal_task")!;
  assert.equal(esc.ownerRole, "officer"); assert.equal(esc.payload.timer_code, "FTC_314_4J_NOTIFICATION_EVENT_30D"); assert.equal(esc.payload.due, D("2026-11-15")); assert.deepEqual(Object.keys(esc.payload.prefilled as object), SIX);
  // the six elements are content the FTC template's checklist enforces from the payload, not from the template's own labels
  const v = version("NTC_FTC_314_4J"); const okOut = render(v.source, v.samplePayload);
  assert.equal(evaluateChecklist(v, v.samplePayload, okOut).passed, true); assert.match(okOut.text, /\(4\) Number of consumers affected or potentially affected: 12400/);
  for (const [field, rule] of [["institution_contact", "e1"], ["information_types", "e2"], ["date_range", "e3"], ["description", "e5"]] as const) { const bad = { ...v.samplePayload, [field]: "" }; assert.ok(evaluateChecklist(v, bad, render(v.source, bad)).blocking.some((r) => r.rule_id === rule), `${field} missing fails ${rule}`); }
  const delayed = { ...v.samplePayload, law_enforcement_delay: true, law_enforcement_contact: "" }; assert.ok(checklist("NTC_FTC_314_4J", delayed).blocking.some((r) => r.rule_id === "e6"));
  assert.ok(checklist("NTC_FTC_314_4J", { ...v.samplePayload, days_since_discovery: 31 }).blocking.some((r) => r.rule_id === "30d"));
  assert.ok(checklist("NTC_FTC_314_4J", { ...v.samplePayload, consumer_count: 499 }).blocking.some((r) => r.rule_id === "500"));
});
test("19.2-T4: Given scoping shows 480 consumers, then no FTC timer is created; given the count is later corrected to 510 on 2026-10-25, then the FTC timer is created anchored to the original discovery date (due 2026-11-15, not 2026-11-24).", async () => {
  const h = harness("2026-10-16T22:00:00.000Z");
  const p480 = persons(480, "TX"), p510 = persons(510, "TX");
  const s480 = scopeIncident({ discovered_on: D("2026-10-16"), persons: p480 });
  assert.deepEqual([s480.consumer_count, s480.ftc.required, s480.ftc.due, s480.ftc.timer], [480, false, null, null]);
  await h.run("incident.scope", AGENT, { incident_id: INC, discovered_on: "2026-10-16", persons: p480 });
  assert.equal(h.armed("FTC_314_4J_NOTIFICATION_EVENT_30D").length, 0, "480 consumers: no FTC timer");
  // the count is corrected to 510 on 2026-10-25: the clock is anchored to the original discovery date
  const correctedMs = Date.parse("2026-10-25T18:00:00.000Z"); h.clock.set(iso(correctedMs));
  const s510 = scopeIncident({ discovered_on: D("2026-10-16"), persons: p510, scoped_ms: correctedMs });
  assert.equal(s510.ftc.due, D("2026-11-15")); assert.notEqual(s510.ftc.due, addDays(D("2026-10-25"), 30));
  assert.equal(addDays(D("2026-10-25"), 30), D("2026-11-24"));
  await h.run("incident.scope", AGENT, { incident_id: INC, discovered_on: "2026-10-16", persons: p510 });
  const ftc = h.armed("FTC_314_4J_NOTIFICATION_EVENT_30D"); assert.equal(ftc.length, 1);
  assert.equal(ftc[0]!.armedAt, iso(correctedMs)); assert.equal(ftc[0]!.anchorDate, D("2026-10-16")); assert.equal(ftc[0]!.dueDate, D("2026-11-15")); assert.notEqual(ftc[0]!.dueDate, D("2026-11-24"));
  // discovery is "the first day on which such event is known": a correction cannot move it later
  await assert.rejects(h.run("incident.scope", AGENT, { incident_id: INC, discovered_on: "2026-10-25", persons: p510 }), /cannot move later/);
  assert.equal(h.rt.store.get("security_incidents", INC)!.data.discovered_at, "2026-10-16");
});
test("19.2-T5: Given an FTC or state-AG notice becomes required, then `security.incident.determined` is required within `SM_NYDFS_DETERMINATION_48H` and the NYDFS 72-hour timer starts from `determined_at` (Mon 10:00 → Thu 10:00 ET).", async () => {
  const h = harness(iso(CONFIRMED));
  await h.identify(INC, S2);
  const det = h.armed("SM_NYDFS_DETERMINATION_48H")[0]!;
  assert.equal(det.dueAt, zonedEpochMs(D("2026-10-18"), "14:30", ET), "+48 h policy clock from identification");
  assert.equal(nydfsClocks(CONFIRMED, null).determination_due_ms, det.dueAt);
  assert.equal(h.armed("NYDFS_500_17A_INCIDENT_NOTICE_72H").length, 0, "no 72-hour clock before a determination");
  // scoping Mon 2026-10-19 10:00 ET finds the FTC and NY AG notices required → prong (1) → `security.incident.determined` at Mon 10:00 → 72 h → Thu 10:00 ET
  const mon = zonedEpochMs(D("2026-10-19"), "10:00", ET); h.clock.set(iso(mon));
  h.timers.evaluate(h.clock.now());   // the policy clock passed Sun 14:30 ET; the determination on Monday closes it late (67.5 h — spec worked timeline)
  const out = await h.run("incident.scope", AGENT, { incident_id: INC, discovered_on: "2026-10-16", persons: WORKED });
  assert.equal((out.output as { nydfs_prong1_met: boolean }).nydfs_prong1_met, true);
  const determined = h.events.ofType("security.incident.determined"); assert.equal(determined.length, 1); assert.equal(determined[0]!.payload.determined_at, iso(mon)); assert.equal(determined[0]!.payload.prong, 1);
  assert.equal(det.status, "satisfied_late"); assert.equal(det.satisfiedAt, iso(mon));
  const n72 = h.armed("NYDFS_500_17A_INCIDENT_NOTICE_72H"); assert.equal(n72.length, 1);
  const c = wallClock(n72[0]!.dueAt!, ET); assert.deepEqual([c.date, c.hour, c.minute], [D("2026-10-22"), 10, 0]);
  assert.equal(nydfsClocks(CONFIRMED, mon).notice_due_ms, n72[0]!.dueAt);
  assert.equal(h.rt.store.get("security_incidents", INC)!.data.determined_at, iso(mon));
  // the portal submission closes the 72-hour clock; a second scope does not re-determine
  await h.run("incident.scope", AGENT, { incident_id: INC, discovered_on: "2026-10-16", persons: WORKED }); assert.equal(h.events.ofType("security.incident.determined").length, 1);
  h.events.append({ ...incidentNoticeSent({ incident_id: INC, recipient: "nydfs", template_code: "NTC_NYDFS_500_17A", sent_ms: mon + 26 * H, sent_by_role: "officer", channel: "portal" }).event, actor: OFFICER });
  assert.equal(n72[0]!.status, "satisfied");
  // prong (1) is met by a state-AG notice alone (under 500 consumers) and not at all when nothing was acquired
  const small = scopeIncident({ discovered_on: D("2026-10-16"), persons: persons(10, "NY") }); assert.equal(small.ftc.required, false); assert.equal(small.nydfs_prong1_met, true);
  const none = scopeIncident({ discovered_on: D("2026-10-16"), persons: persons(10, "NY", true, false) }); assert.equal(none.consumer_count, 0); assert.equal(none.nydfs_prong1_met, false);
  // the DFS payload: within 72 hours of determination, prong (1) bodies named
  const v = version("NTC_NYDFS_500_17A"); assert.equal(checklist("NTC_NYDFS_500_17A", v.samplePayload).passed, true);
  assert.ok(checklist("NTC_NYDFS_500_17A", { ...v.samplePayload, hours_since_determination: 73 }).blocking.some((r) => r.rule_id === "72h"));
  assert.ok(checklist("NTC_NYDFS_500_17A", { ...v.samplePayload, prong1_bodies: "" }).blocking.some((r) => r.rule_id === "prong1-bodies"));
});
test("19.2-T6: Given 3,100 NY residents, then NY consumer + AG/DOS/State Police/DFS timers exist with due 2026-11-15 and no CRA timer; given 5,001 NY residents, the CRA timer exists.", async () => {
  const s = scopeIncident({ discovered_on: D("2026-10-16"), persons: persons(3_100, "NY") });
  const ny = s.states.find((x) => x.state === "NY")!;
  assert.deepEqual([ny.residents, ny.consumer_due, ny.ag_due, ny.cra_due], [3_100, D("2026-11-15"), D("2026-11-15"), null]);
  assert.deepEqual(ny.timers.map((t) => t.code), ["STATE_BREACH_CONSUMER_NOTICE_NY_30D", "STATE_BREACH_REGULATOR_NOTICE_NY"]);
  assert.deepEqual(stateRegulatorRecipients("NY"), ["state_ag:NY", "state_other:NY_DOS", "state_other:NY_STATE_POLICE", "nydfs"], "AG, Department of State, State Police, DFS");
  const h = harness("2026-10-19T14:00:00.000Z");
  await h.run("incident.scope", AGENT, { incident_id: INC, discovered_on: "2026-10-16", persons: persons(3_100, "NY") });
  for (const code of ["STATE_BREACH_CONSUMER_NOTICE_NY_30D", "STATE_BREACH_REGULATOR_NOTICE_NY"]) { const t = h.armed(code); assert.equal(t.length, 1, code); assert.equal(t[0]!.anchorDate, D("2026-10-16")); assert.equal(t[0]!.dueDate, D("2026-11-15")); }
  assert.equal(h.armed("STATE_BREACH_CRA_NOTICE_NY_5000").length, 0, "3,100 < 5,000: no CRA timer");
  // 5,001 NY residents → the CRA timer exists; 5,000 is not "more than five thousand" (§899-aa(8)(b))
  const h2 = harness("2026-10-19T14:00:00.000Z");
  await h2.run("incident.scope", AGENT, { incident_id: "INC-CRA", discovered_on: "2026-10-16", persons: persons(5_001, "NY") });
  const cra = h2.armed("STATE_BREACH_CRA_NOTICE_NY_5000"); assert.equal(cra.length, 1); assert.equal(cra[0]!.dueDate, D("2026-11-15"));
  assert.equal(scopeIncident({ discovered_on: D("2026-10-16"), persons: persons(5_001, "NY") }).states[0]!.cra_due, D("2026-11-15"));
  assert.equal(scopeIncident({ discovered_on: D("2026-10-16"), persons: persons(5_000, "NY") }).states[0]!.cra_due, null);
  const r5000 = stateBreachClocks("NY", D("2026-10-16"), 5_000); assert.ok(!("refused" in r5000) && r5000.cra_due === null);
  // the regulator timer closes only when all four regulators have been notified; the consumer timer only when every NY resident has a mailed or substitute notice
  const sentMs = zonedEpochMs(D("2026-11-12"), "15:00", ET);
  const partial = stateRegulatorNoticesComplete("NY", INC, [{ recipient: "state_ag:NY", sent_ms: sentMs }]); assert.equal(partial.complete, false); assert.deepEqual(partial.missing, ["state_other:NY_DOS", "state_other:NY_STATE_POLICE", "nydfs"]); assert.equal(partial.event, null);
  const all = stateRegulatorNoticesComplete("NY", INC, stateRegulatorRecipients("NY").map((recipient, k) => ({ recipient, sent_ms: sentMs + k * MIN }))); assert.equal(all.complete, true);
  h.events.append({ ...all.event!, actor: OFFICER }); assert.equal(h.armed("STATE_BREACH_REGULATOR_NOTICE_NY")[0]!.status, "satisfied");
  assert.equal(consumerNoticesMailed("NY", INC, 3_100, 3_000, 0, sentMs).event, null);
  const mailed = consumerNoticesMailed("NY", INC, 3_100, 3_050, 50, sentMs); assert.equal(mailed.all_residents, true);
  h.events.append({ ...mailed.event!, actor: OFFICER }); assert.equal(h.armed("STATE_BREACH_CONSUMER_NOTICE_NY_30D")[0]!.status, "satisfied");
  // the CRA notice itself: more than five thousand, timing/content/distribution
  const v = version("NTC_BREACH_CRA"); assert.equal(checklist("NTC_BREACH_CRA", v.samplePayload).passed, true);
  assert.ok(checklist("NTC_BREACH_CRA", { ...v.samplePayload, ny_residents: 5_000 }).blocking.some((r) => r.rule_id === "5000"));
  assert.ok(checklist("NTC_BREACH_CRA", { ...v.samplePayload, distribution: "" }).blocking.some((r) => r.rule_id === "distribution"));
});
test("19.2-T7: Given a state with no `breach_notice` matrix row, then clock computation is refused and an `attorney` escalation is created within 1 hour.", async () => {
  const scopedMs = Date.parse("2026-10-19T14:00:00.000Z");
  const mixed = [...persons(10, "NY"), ...persons(5, "OH")];
  const s = scopeIncident({ discovered_on: D("2026-10-16"), persons: mixed, scoped_ms: scopedMs });
  assert.deepEqual(s.refused_states, ["OH"]); assert.deepEqual(s.states.map((x) => x.state), ["NY"]);
  const esc = s.escalations.find((e) => e.kind === "attorney")!;
  assert.equal(esc.within_minutes, 60); assert.equal(esc.by_ms, scopedMs + 60 * MIN); assert.match(esc.reason, /no jurisdiction_rules.breach_notice row for OH/);
  assert.deepEqual(stateBreachClocks("OH", D("2026-10-16"), 5), { refused: true, escalate: "attorney", within_minutes: 60 });
  // on the bus: the attorney escalation is opened with its one-hour SLA and no OH clock is computed
  const h = harness(iso(scopedMs));
  await h.run("incident.scope", AGENT, { incident_id: INC, discovered_on: "2026-10-16", persons: mixed });
  const a = h.rt.escalations.opened.find((e) => e.kind === "attorney")!;
  assert.equal(a.ownerRole, "attorney"); assert.equal(a.payload.within_minutes, 60); assert.equal(a.payload.by, "2026-10-19T15:00:00.000Z");
  assert.ok(h.timers.all().every((t) => !/_OH\b/.test(t.code))); assert.equal(h.armed("STATE_BREACH_CONSUMER_NOTICE_NY_30D").length, 1, "the NY clock still runs");
  assert.ok(h.events.ofType("escalation.created").some((e) => e.payload.kind === "attorney" && e.payload.within_minutes === 60));
});
test("19.2-T8: Given a BEC with no data impact, then severity is S2 and the Fannie Mae 36-hour timer still exists (reportable regardless of impact).", () => {
  const t = triageIncident(BEC);
  assert.equal(t.severity, "S2"); assert.ok(t.fnma_reportable); assert.ok(t.external_notice_allowed);
  const fnma = t.timers.find((x) => x.code === "FNMA_SUPP_INCIDENT_NOTICE_36H");
  assert.ok(fnma, "the Fannie Mae 36-hour timer exists for a BEC with no data impact");
  const due = wallClock(fnma.due_ms, ET); assert.deepEqual([due.date, due.hour, due.minute], [D("2026-10-18"), 2, 30]);
  const partner = t.timers.find((x) => x.code === "SM_PARTNER_INCIDENT_NOTICE_24H"); assert.ok(partner); assert.equal(wallClock(partner.due_ms, ET).date, D("2026-10-17"));
  assert.equal(t.identified_at_ms, CONFIRMED, "identification is the SOC confirmation and is never postponed");
  assert.equal(t.event?.type, "security.incident.identified"); assert.equal(t.event?.payload.data_impact, false); assert.equal(t.event?.payload.severity, "S2");
  assert.ok(t.escalations.some((e) => e.kind === "officer"), "notices are officer-sent");
  // contrast: the same contained event that is not a BEC and carries no reasonable conclusion is S3 — logged, no clocks, no external notice
  const s3 = triageIncident({ ...BEC, category: "credential_compromise" });
  assert.equal(s3.severity, "S3"); assert.deepEqual(s3.timers, []); assert.equal(s3.external_notice_allowed, false); assert.equal(s3.identified_at_ms, null);
  // a later downgrade S2 → S3 needs the CISO
  assert.deepEqual(severityChange("S2", "S3", false), { allowed: false, refusal: "severity downgrade from S2 to S3 requires CISO approval (19.2 escalations)", requires: "ciso" });
  assert.equal(severityChange("S2", "S3", true).allowed, true); assert.equal(severityChange("S3", "S1", false).allowed, true);
  // the Supplement notice names the BEC as reportable regardless of impact
  const v = version("NTC_FNMA_INCIDENT_36H"); const bec = { ...v.samplePayload, category: "bec", bec: true }; assert.match(render(v.source, bec).text, /business-email compromise — reportable regardless of impact/);
});
test("19.2-T9: Given an extortion payment at 2026-10-20 16:00 ET, then notices are due 2026-10-21 16:00 ET and 2026-11-19.", async () => {
  const paid = zonedEpochMs(D("2026-10-20"), "16:00", ET);
  const e = extortionClocks(paid);
  const c = wallClock(e.nydfs_due_ms, ET); assert.deepEqual([c.date, c.hour, c.minute], [D("2026-10-21"), 16, 0]); assert.equal(e.ftc_or_dfs_30d, D("2026-11-19"));
  // the registry rows from `extortion.payment.made`: 24 clock hours and 30 calendar days from the payment
  const h = harness(iso(paid));
  h.events.append({ type: "extortion.payment.made", actor: OFFICER, aggregate: { kind: "security_incident", id: INC }, payload: { incident_id: INC, amount_cents: 25_000_000n, paid_at: iso(paid), authorized_by: "CEO with counsel" } });
  const n24 = h.armed("NYDFS_500_17C_EXTORTION_PAYMENT_NOTICE_24H"), n30 = h.armed("NYDFS_500_17C_EXTORTION_EXPLANATION_30D");
  assert.equal(n24.length, 1); assert.equal(n24[0]!.dueAt, zonedEpochMs(D("2026-10-21"), "16:00", ET));
  assert.equal(n30.length, 1); assert.equal(n30[0]!.dueDate, D("2026-11-19"));
  // the 24-hour notice closes only its own timer; the 30-day written explanation closes the other
  h.events.append({ ...incidentNoticeSent({ incident_id: INC, recipient: "nydfs", template_code: "NTC_NYDFS_500_17C_EXTORTION_24H", sent_ms: paid + 6 * H, sent_by_role: "officer", channel: "portal" }).event, actor: OFFICER });
  assert.equal(n24[0]!.status, "satisfied"); assert.equal(n30[0]!.status, "armed");
  h.events.append({ ...incidentNoticeSent({ incident_id: INC, recipient: "nydfs", template_code: "NTC_NYDFS_500_17C_EXTORTION_30D", sent_ms: zonedEpochMs(D("2026-11-18"), "11:00", ET), sent_by_role: "officer", channel: "portal" }).event, actor: OFFICER });
  assert.equal(n30[0]!.status, "satisfied");
  // the 24-hour notice: amount, OFAC diligence, the 30-day commitment, and never an agent's payment
  const v = version("NTC_NYDFS_500_17C_EXTORTION_24H"); const out = render(v.source, v.samplePayload);
  assert.equal(evaluateChecklist(v, v.samplePayload, out).passed, true); assert.match(out.text, /in the amount of \$250,000\.00/); assert.match(out.text, /by November 19, 2026/);
  assert.ok(checklist("NTC_NYDFS_500_17C_EXTORTION_24H", { ...v.samplePayload, paid_by_agent: true }).blocking.some((r) => r.rule_id === "no-agent-payment"));
  assert.ok(checklist("NTC_NYDFS_500_17C_EXTORTION_24H", { ...v.samplePayload, hours_since_payment: 25 }).blocking.some((r) => r.rule_id === "24h"));
});
test("19.2-T10: Given CTL-SEC-01 finds one human account without MFA, then the control result is `fail`, the account is disabled within 15 minutes, and the finding appears in the next board report unless an approved exception exists.", async () => {
  const ran = zonedEpochMs(D("2026-10-05"), "06:00", ET);
  const r = mfaControlTest([{ id: "h1", kind: "human", mfa_method: "fido2", privileged: true }, { id: "h2", kind: "human", mfa_method: null }, { id: "s1", kind: "system", mfa_method: null }], ran);
  assert.equal(r.control, "CTL-SEC-01"); assert.equal(r.result, "fail"); assert.deepEqual(r.findings, ["h2: no MFA"]);
  assert.deepEqual(r.actions, [{ action: "idp.disableIdentity", target: "h2", by_ms: ran + 15 * MIN }]);
  assert.deepEqual(r.board_report_items, ["CTL-SEC-01 fail: h2 without MFA"]); assert.equal(r.escalation?.kind, "sev2");
  // with an approved exception (Qualified Individual, compensating controls) the finding is `exception`: no disable, nothing for the board report
  const ex = mfaControlTest([{ id: "h2", kind: "human", mfa_method: null, exception_approved: true }], ran);
  assert.equal(ex.result, "exception"); assert.deepEqual(ex.actions, []); assert.deepEqual(ex.board_report_items, []); assert.equal(ex.escalation, null);
  assert.equal(mfaControlTest([{ id: "h1", kind: "human", mfa_method: "totp" }], ran).result, "pass");
  // on the bus: controls.runTest reads the identity mirror, writes the control_test_results row, opens the CISO's sev-2; the agent then disables the account (logged, reversible)
  const h = harness(iso(ran));
  h.rt.store.put("identities", "h1", { kind: "human", mfa_method: "fido2", privileged: true }, OFFICER, h.clock.now()); h.rt.store.put("identities", "h2", { kind: "human", mfa_method: null }, OFFICER, h.clock.now());
  const out = (await h.run("controls.runTest", AGENT, { control_code: "CTL-SEC-01" })).output as { result: string; board_report_items: string[]; actions: { target: string; by_ms: number }[] };
  assert.equal(out.result, "fail"); assert.deepEqual(out.board_report_items, ["CTL-SEC-01 fail: h2 without MFA"]); assert.equal(out.actions[0]!.by_ms, ran + 15 * MIN);
  assert.equal(h.rt.store.list("control_test_results").length, 1); assert.equal(h.rt.escalations.opened[0]!.kind, "sev2"); assert.equal(h.rt.escalations.opened[0]!.ownerRole, "ciso");
  h.clock.set(iso(ran + 10 * MIN));
  await h.run("idp.disableIdentity", AGENT, { identity_id: "h2", reason: "CTL-SEC-01: no MFA" });
  const h2 = h.rt.store.get("identities", "h2")!.data; assert.equal(h2.disabled_at, iso(ran + 10 * MIN)); assert.equal(h2.reversible, true);
  assert.ok(Date.parse(h2.disabled_at as string) <= out.actions[0]!.by_ms, "disabled within 15 minutes");
  assert.ok(h.events.ofType("identity.disabled").some((e) => e.payload.identity_id === "h2"));
});
test("19.2-T11: Given a Fannie Mae System ID last rotated 2025-10-01, then on 2026-10-01 the credential is auto-disabled and a sev-1 raised; given a human Fannie Mae credential last reset 2026-07-01, then it is reset by 2026-09-29.", async () => {
  const sys = credentialResetClock("fnma_system_id", D("2025-10-01"), D("2026-10-01"));
  assert.deepEqual([sys.due, sys.period_days, sys.auto_disable, sys.disabled_on, sys.escalation?.kind, sys.action?.action], [D("2026-10-01"), 365, true, D("2026-10-01"), "sev1", "idp.disableIdentity"]);
  assert.match(sys.escalation!.reason, /Fannie Mae System ID not reset within 365 days of 2025-10-01: auto-disabled 2026-10-01/);
  const day364 = credentialResetClock("fnma_system_id", D("2025-10-01"), D("2026-09-30")); assert.equal(day364.disabled_on, null); assert.equal(day364.escalation, null);
  const human = credentialResetClock("human", D("2026-07-01"), D("2026-09-28"));
  assert.deepEqual([human.due, human.period_days, human.disabled_on, human.escalation], [D("2026-09-29"), 90, null, null]);
  const overdue = credentialResetClock("human", D("2026-07-01"), D("2026-09-29"));   // rule 5: human Fannie Mae credentials auto-disable on breach too
  assert.equal(overdue.auto_disable, true); assert.equal(overdue.escalation?.kind, "sev1"); assert.equal(overdue.disabled_on, D("2026-09-29"));
  // the registry row: the reset event arms the 90-day clock from reset_at; the breach column auto-disables at sev-1
  const h = harness("2026-07-01T14:00:00.000Z");
  await h.run("vault.rotateSecret", AGENT, { secret_id: "fnma-user-jdoe", kind: "human", fnma_credentials: true });
  const t = h.armed("FNMA_TECHGUIDE_CREDENTIAL_RESET_90D"); assert.equal(t.length, 1); assert.equal(t[0]!.anchorDate, D("2026-09-29"), "anchored on the event's reset_due (reset_at + 90 for a human credential; one registry code covers the 365-day system-ID period)"); assert.equal(t[0]!.dueDate, D("2026-09-29"));
  assert.equal(h.reg.get("FNMA_TECHGUIDE_CREDENTIAL_RESET_90D")!.severity.level, 1); assert.match(h.reg.get("FNMA_TECHGUIDE_CREDENTIAL_RESET_90D")!.breach, /credential auto-disabled at breach/);
  // the next reset (inside the window) is the satisfying event of the same row (the engine re-arms a recurring row on satisfaction — see notes)
  const reset = h.events.ofType("identity.credential.reset")[0]!; assert.equal(reset.payload.reset_at, "2026-07-01T14:00:00.000Z");
  assert.equal(eventMatches(h.reg.get("FNMA_TECHGUIDE_CREDENTIAL_RESET_90D")!.satisfiedPattern!, { ...reset, occurredAt: "2026-09-28T14:00:00.000Z", payload: { ...reset.payload, reset_at: "2026-09-28T14:00:00.000Z" } }), true);
  assert.equal(eventMatches(h.reg.get("FNMA_TECHGUIDE_CREDENTIAL_RESET_90D")!.satisfiedPattern!, { ...reset, payload: { ...reset.payload, fnma_credentials: false } }), false, "a non-Fannie Mae credential reset does not close the Fannie Mae clock");
});
test("19.2-T12: Given a critical CVE on an internet-facing asset detected 2026-11-02 09:00 ET, then `SM_VULN_REMEDIATION_SLA` is due 2026-11-05 09:00 ET.", () => {
  const detected = zonedEpochMs(D("2026-11-02"), "09:00", ET);
  const v = vulnerabilityDetected({ vulnerability_id: "V-2026-0917", asset_id: "edge-lb-1", cve: "CVE-2026-0001", severity: "critical", internet_facing: true, detected_ms: detected });
  const c = wallClock(v.sla_due_ms, ET); assert.deepEqual([c.date, c.hour, c.minute], [D("2026-11-05"), 9, 0], "72 h → 2026-11-05 09:00 ET");
  assert.deepEqual([v.timer_code, v.remediation_due, v.breach_severity, v.row.sla_due_at, v.event.payload.remediation_due], ["SM_VULN_REMEDIATION_SLA", D("2026-11-05"), "sev1", iso(v.sla_due_ms), D("2026-11-05")]);
  assert.equal(vulnRemediationDueMs(detected, "critical", true), v.sla_due_ms);
  assert.equal(wallClock(vulnRemediationDueMs(detected, "critical", false), ET).date, D("2026-11-09"), "critical, not internet-facing: 7 d");
  // the registry row arms from `vulnerability.detected` on the computed anchor `remediation_due` and closes on `vulnerability.remediated`
  const h = harness(iso(detected));
  h.events.append({ ...v.event, actor: SCANNER });
  const t = h.armed("SM_VULN_REMEDIATION_SLA"); assert.equal(t.length, 1); assert.equal(t[0]!.anchorDate, D("2026-11-05")); assert.equal(t[0]!.dueDate, D("2026-11-05"));
  assert.notEqual(t[0]!.dueDate, D("2026-11-02"), "not the detection day");
  h.events.append({ type: "vulnerability.remediated", actor: SCANNER, aggregate: { kind: "vulnerability", id: "V-2026-0917" }, payload: { vulnerability_id: "V-2026-0917", remediated_at: iso(detected + 40 * H) } });
  assert.equal(t[0]!.status, "satisfied");
});
test("19.2-T13: Given a quarterly restore test that fails to restore Tier 0 within 4 hours, then `NYDFS_500_16D_BACKUP_RESTORE_TEST_365` is `failed`, a sev-1 is raised and the BCP exception is logged.", () => {
  const ranPass = zonedEpochMs(D("2026-01-15"), "03:00", ET), ranFail = zonedEpochMs(D("2026-10-15"), "03:00", ET);
  const pass = backupRestoreTest({ tier: 0, hours_to_restore: 3.5, ran_ms: ranPass }); assert.equal(pass.result, "pass"); assert.equal(pass.timer_disposition, "satisfied"); assert.equal(pass.event.type, "backup_restore_test.passed"); assert.equal(pass.bcp_exception, null);
  const fail = backupRestoreTest({ tier: 0, hours_to_restore: 5, ran_ms: ranFail });
  assert.deepEqual([fail.result, fail.rto_hours, fail.timer_code, fail.timer_disposition, fail.escalation?.kind, fail.escalation?.owner_role, fail.bcp_exception?.control_code, fail.event.type], ["fail", 4, "NYDFS_500_16D_BACKUP_RESTORE_TEST_365", "failed", "sev1", "ciso", "CTL-SEC-16", "backup_restore_test.failed"]);
  assert.match(fail.bcp_exception!.justification, /missed the 4-hour RTO \(5 h\)/); assert.equal(fail.bcp_exception!.logged_at, iso(ranFail));
  assert.equal(backupRestoreTest({ tier: 1, hours_to_restore: 5, ran_ms: ranFail }).result, "pass", "Tier 1 RTO is 8 h");
  // the annual clock runs from the last passed test; the failed quarterly restore neither satisfies nor restarts it
  const h = harness(iso(ranPass));
  h.events.append({ ...pass.event, actor: SCANNER });
  const t = h.armed("NYDFS_500_16D_BACKUP_RESTORE_TEST_365"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, D("2027-01-15"));
  h.clock.set(iso(ranFail)); h.events.append({ ...fail.event, actor: SCANNER });
  assert.equal(h.armed("NYDFS_500_16D_BACKUP_RESTORE_TEST_365").length, 1); assert.equal(t[0]!.status, "armed");
  assert.equal(h.reg.get("NYDFS_500_16D_BACKUP_RESTORE_TEST_365")!.severity.level, 1);
});
test("19.2-T14: Given any control `fail` without an approved exception on Apr 1, then the NYDFS April 15 package is generated as an acknowledgment of noncompliance with the deficient sections listed, not a certification.", () => {
  const signers = { ceo_name: "C. Executive", ceo_title: "Chief Executive Officer", ciso_name: "A. Lead", entity_name: "Supermortgage" };
  const controls = [{ id: "CTL-SEC-01", result: "fail", exception_approved: false }, { id: "CTL-SEC-03", result: "pass", exception_approved: false }] as const;
  const p = nydfsAnnualPackage(controls, D("2027-04-01"), signers);
  assert.equal(p.kind, "acknowledgment_of_noncompliance"); assert.deepEqual(p.deficient_controls, ["CTL-SEC-01"]);
  assert.deepEqual(p.deficient_sections, ["500.12 (multi-factor authentication) — CTL-SEC-01 failed without an approved exception as of 2027-04-01"]);
  assert.equal(p.filing_deadline, D("2027-04-15")); assert.equal(p.days_before_apr15, 14); assert.equal(p.payload.certification, false); assert.equal(p.payload.year, 2026);
  // the package renders as the acknowledgment with the deficient sections and passes the 500.17(b) checklist
  const v = version("NTC_NYDFS_ANNUAL_CERT"); const payload = { ...v.samplePayload, ...p.payload }; const out = render(v.source, payload);
  assert.match(out.text, /Acknowledgment of Noncompliance for calendar year 2026/); assert.match(out.text, /Sections not materially complied with: 500\.12 \(multi-factor authentication\)/); assert.doesNotMatch(out.text, /certifies that/);
  assert.equal(evaluateChecklist(v, payload, out).passed, true);
  // the same fail under an approved exception → a certification; a certification asserted over an unexcepted fail is refused by the checklist
  const ok = nydfsAnnualPackage([{ id: "CTL-SEC-01", result: "fail", exception_approved: true }], D("2027-04-01"), signers);
  assert.equal(ok.kind, "certification"); assert.deepEqual(ok.deficient_sections, []);
  const okPayload = { ...v.samplePayload, ...ok.payload }; const okOut = render(v.source, okPayload); assert.match(okOut.text, /Certification of Material Compliance/); assert.equal(evaluateChecklist(v, okPayload, okOut).passed, true);
  const forged = { ...payload, certification: true }; assert.ok(evaluateChecklist(v, forged, render(v.source, forged)).blocking.some((r) => r.rule_id === "cert-clean"));
  const unsigned = { ...payload, ciso_name: "" }; assert.ok(evaluateChecklist(v, unsigned, render(v.source, unsigned)).blocking.some((r) => r.rule_id === "signers"));
  assert.equal(nydfsAnnualPackage([], D("2027-04-16"), signers).filing_deadline, D("2028-04-15"), "after April 15 the next filing is next year's");
});
test("19.2-T15: Given the TLS profile still allows a non-ECDHE-GCM cipher on 2026-10-22, then CTL-SEC-03 fails sev-1 before the Oct 23 cutoff.", async () => {
  const r = tlsControlTest(["ECDHE-RSA-AES256-GCM-SHA384", "AES256-SHA"], D("2026-10-22"));
  assert.equal(r.control, "CTL-SEC-03"); assert.equal(r.result, "fail"); assert.deepEqual(r.findings, ["AES256-SHA: not an ECDHE-GCM cipher"]);
  assert.equal(r.escalation?.kind, "sev1"); assert.equal(r.before_cutoff, true); assert.equal(r.cutoff, D("2026-10-23")); assert.match(r.escalation!.reason, /before the 2026-10-23 cutoff/);
  assert.equal(tlsControlTest(["ECDHE-ECDSA-AES128-GCM-SHA256", "ECDHE-RSA-AES256-GCM-SHA384"], D("2026-10-22")).result, "pass");
  assert.equal(tlsControlTest([], D("2026-10-22")).result, "fail", "no inventory: fail-closed");
  // the FNMA_TECHGUIDE_TLS_CIPHER_CUTOFF gate is closed while the legacy cipher is enabled
  const reg = loadRegistry(); applyDataSecurityTimerOverrides(reg); const def = reg.get("FNMA_TECHGUIDE_TLS_CIPHER_CUTOFF")!;
  assert.equal(def.offsetParsed.kind, "evaluator"); assert.equal((def.offsetParsed as { ref: string }).ref, "19.2.tlsProfileEcdheGcmOnly");
  const gate = EVALUATORS_19_2["19.2.tlsProfileEcdheGcmOnly"]!;
  assert.equal(gate({ ciphers: ["ECDHE-RSA-AES256-GCM-SHA384", "AES256-SHA"] }).open, false); assert.equal(gate({ ciphers: ["ECDHE-ECDSA-AES128-GCM-SHA256"] }).open, true); assert.equal(gate({ ciphers: [] }).open, false);
  // on the bus: controls.runTest on 2026-10-22 records the fail and opens the sev-1 to the CISO before the cutoff
  const h = harness("2026-10-22T12:00:00.000Z");
  const out = (await h.run("controls.runTest", AGENT, { control_code: "CTL-SEC-03", ciphers: ["ECDHE-RSA-AES256-GCM-SHA384", "AES256-SHA"] })).output as { result: string; before_cutoff: boolean };
  assert.equal(out.result, "fail"); assert.equal(out.before_cutoff, true);
  const esc = h.rt.escalations.opened[0]!; assert.equal(esc.kind, "sev1"); assert.equal(esc.ownerRole, "ciso"); assert.match(String(esc.payload.reason), /AES256-SHA before the 2026-10-23 cutoff/);
  assert.equal(h.rt.store.list("control_test_results")[0]!.data.result, "fail");
});
test("19.2-T16: Given an agent containment action would disable > 50 identities, then it is blocked pending CISO approval.", async () => {
  const ids51 = Array.from({ length: 51 }, (_, i) => `u${i}`);
  assert.deepEqual(containmentAction({ targets: ids51, ciso_approved: false }), { allowed: false, refusal: "51 targets exceed the blast-radius limit of 50; blocked pending CISO approval", pending: "ciso", reversible: true });
  assert.equal(containmentAction({ targets: ids51, ciso_approved: true }).allowed, true); assert.equal(containmentAction({ targets: ids51.slice(0, 50), ciso_approved: false }).allowed, true);
  // on the bus: the agent's 51-identity disable is refused before anything runs; with the CISO's approval it proceeds (logged, reversible)
  const h = harness("2026-10-16T19:00:00.000Z");
  await assert.rejects(async () => h.run("idp.disableIdentity", AGENT, { identity_ids: ids51, incident_id: INC }), (e: unknown) => e instanceof CommandRefused && e.code === "BLAST_RADIUS_CISO");
  assert.equal(h.rt.store.list("identities").length, 0); assert.deepEqual(h.events.all().map((e) => e.type), ["escalation.created", "command.refused"]);   // the CISO approval item opens with the refusal
  const ok = (await h.run("idp.disableIdentity", AGENT, { identity_ids: ids51, incident_id: INC, ciso_approved: true })).output as { disabled: string[] };
  assert.equal(ok.disabled.length, 51); assert.equal(h.events.ofType("identity.disabled").length, 51); assert.equal(h.rt.store.get("identities", "u7")!.data.reversible, true);
  // the same limit on secrets and hosts; the rate limit also waits for the CISO
  await assert.rejects(h.run("vault.rotateSecret", AGENT, { secret_ids: ids51.map((x) => `s-${x}`) }), (e: unknown) => e instanceof CommandRefused && e.code === "BLAST_RADIUS_CISO");
  await assert.rejects(h.run("cloud.isolateHost", AGENT, { host_ids: ids51.map((x) => `h-${x}`) }), (e: unknown) => e instanceof CommandRefused && e.code === "BLAST_RADIUS_CISO");
  await assert.rejects(h.run("cloud.isolateHost", AGENT, { host_id: "h-1", actions_last_hour: 50 }), (e: unknown) => e instanceof CommandRefused && e.code === "CONTAINMENT_RATE_LIMIT");
  // never the officer break-glass accounts — per the identity registry's flag, whatever the caller says
  h.rt.store.put("identities", "svc-emergency-01", { kind: "human", break_glass: true, role: "officer" }, OFFICER, h.clock.now());
  await assert.rejects(h.run("idp.disableIdentity", AGENT, { identity_ids: ["svc-emergency-01"], ciso_approved: true }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_BREAK_GLASS_DISABLE");
  assert.equal(h.rt.store.get("identities", "svc-emergency-01")!.data.disabled_at, undefined);
  await assert.rejects(h.run("idp.disableIdentity", CISO, { identity_id: "officer-break-glass-2" }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_BREAK_GLASS_DISABLE");
  assert.match(containmentAction({ targets: ["u-break-glass-1"], ciso_approved: true }).refusal!, /break-glass/);
  // and drafts never carry restricted FL data or full SSNs
  assert.deepEqual(restrictedPromptFields({ loan_token: "L-1", borrower: { race: "x" }, note: "123-45-6789" }), ["borrower.race", "note: full SSN"]);
  await assert.rejects(h.run("notices.draft", AGENT, { template_code: "NTC_FNMA_INCIDENT_36H", incident_id: INC, data: { ethnicity_codes: [1] } }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_RESTRICTED_FL_DATA_OR_SSN");
  await assert.rejects(h.run("notices.draft", AGENT, { template_code: "NTC_FNMA_INCIDENT_36H", incident_id: INC, recipient: "someone@example.com" }), (e: unknown) => e instanceof CommandRefused && e.code === "VERIFIED_RECIPIENTS_ONLY");
  h.rt.store.put("verified_recipients", "privacy_office@fanniemae.com", { kind: "fannie_mae_supplement" }, OFFICER, h.clock.now());
  assert.equal(((await h.run("notices.draft", AGENT, { template_code: "NTC_FNMA_INCIDENT_36H", incident_id: INC, recipient: "privacy_office@fanniemae.com" })).output as { status: string }).status, "draft_for_officer");
});
test("19.2-T17: Given AI off, then the human IR lead can execute the same runbook with identical timers and templates.", async () => {
  const s1: TriageInput = { ...S2, category: "data_exfiltration", confirmed_exposure: true, incident_id: "INC-17" };
  const on = irRunbook({ ...s1, ai_first: true });
  assert.equal(on.executor, "security-records"); assert.equal(on.console_role, null);
  // AI off: the CISO team records the same identification from the ops console; the platform arms the registry rows; the IR lead reads them through timers.read
  const h = harness(iso(CONFIRMED));
  await h.identify("INC-17", s1, CISO);
  const listed = (await h.run("timers.read", CISO, { op: "open" })).output as { code: string; status: string }[];
  const armed = h.timers.open().map((t) => ({ code: t.code, due_ms: t.dueAt! }));
  assert.deepEqual(listed.map((t) => t.code).sort(), armed.map((t) => t.code).sort());
  const off = irRunbook({ ...s1, ai_first: false, armed_timers: armed });
  assert.equal(off.executor, "human_ir_lead"); assert.equal(off.console_role, "ciso");
  // identical timers: what the registry armed from the console's event equals what the agent computes — code by code, instant by instant
  assert.deepEqual(off.timers, on.timers);
  assert.deepEqual(off.timers.map((t) => t.code), ["FNMA_FORM101_DATA_INCIDENT_NOTICE_36H", "FNMA_SUPP_INCIDENT_NOTICE_36H", "FNMA_SUPP_POST_INCIDENT_ASSESSMENT", "SM_NYDFS_DETERMINATION_48H", "SM_PARTNER_INCIDENT_NOTICE_24H"]);
  assert.equal(off.timers.find((t) => t.code === "FNMA_SUPP_POST_INCIDENT_ASSESSMENT")!.due_ms, postIncidentAssessmentClocks(CONFIRMED).complete_by_ms);
  assert.notDeepEqual(irRunbook({ ...s1, ai_first: false, armed_timers: armed.slice(1) }).timers, on.timers, "the equality is a property of the registry, not a constant");
  assert.deepEqual(off.steps, on.steps); assert.deepEqual(off.templates, on.templates);
  // the same registry rows: every runbook timer code is a 19.2 row that is armable and satisfiable after this section's overrides
  for (const code of off.steps.flatMap((s) => s.timer_codes)) { const def = h.reg.get(code); assert.ok(def && def.process === "19.2", `${code} is a 19.2 timer`); assert.ok(def.triggerPattern && (def.satisfiedPattern || def.offsetParsed.kind === "evaluator"), `${code} is armable and satisfiable`); }
  assert.ok(h.reg.get("FNMA_TECHGUIDE_TLS_CIPHER_CUTOFF")!.offsetParsed.kind === "evaluator" && "19.2.tlsProfileEcdheGcmOnly" in EVALUATORS_19_2);
  // the same templates: every runbook template is authored for 19.2, publishes, and its sample passes its own checklist
  const authored = new Set(VERSIONS_19_2.map((v) => v.templateCode));
  for (const code of off.templates) { assert.ok(authored.has(code), `${code} authored in section19-2`); const v = notices.activeVersion(code, D("2026-09-01")); assert.ok(v, `${code} active`); assert.equal(evaluateChecklist(v, v.samplePayload, render(v.source, v.samplePayload)).passed, true, `${code} sample passes`); }
  // the same tools: every runbook tool is on the bus for 19.2 and callable by the CISO team from the ops console (no humanOnly, `ciso` in humanRoles)
  const tools = new Map(TOOLS_19_2.map((t) => [t.name, t]));
  for (const name of off.steps.flatMap((s) => s.tools)) { const t = tools.get(name); assert.ok(t, `${name} on the bus`); assert.ok(t.humanRoles?.includes("ciso"), `${name} executable by the CISO team`); assert.notEqual(t.humanOnly, true); }
  assert.equal(TOOLS_19_2.length, 12);
  // and the human path's notices close the same clocks the agent path would: the officer's Supplement send from the console satisfies the 36-hour row
  h.events.append({ ...incidentNoticeSent({ incident_id: "INC-17", recipient: "fannie_mae_supplement", template_code: "NTC_FNMA_INCIDENT_36H", sent_ms: CONFIRMED + 18 * H, sent_by_role: "officer", channel: "email" }).event, actor: OFFICER });
  assert.equal(h.armed("FNMA_SUPP_INCIDENT_NOTICE_36H")[0]!.status, "satisfied");
});

test("19.2 worked timeline: 2026-10-16 14:30 ET identification → assessment engaged 2026-10-30 / complete 2027-01-14; 12,400 consumers (3,100 NY, 2,000 TX) → FTC 2026-11-15 (target 11-13), NY 11-15 no CRA, TX 12-15 / AG 11-15; unmatrixed state refused to attorney; vuln SLA 72 h / 30 d", () => {
  assert.deepEqual([postIncidentAssessmentClocks(CONFIRMED).engage_by, postIncidentAssessmentClocks(CONFIRMED).complete_by], [D("2026-10-30"), D("2027-01-14")]);
  const rows = Array.from({ length: 12_400 }, (_, i) => ({ id: `b${i}`, state: i < 3_100 ? "NY" : i < 5_100 ? "TX" : "OH", encrypted: false, key_compromised_or_presumed: false }));
  const s = scopeIncident({ discovered_on: D("2026-10-16"), persons: [...rows, rows[0]!] });   // duplicate row counts once
  assert.equal(s.consumer_count, 12_400); assert.equal(s.unencrypted_customer_info_acquired, "yes"); assert.equal(s.residents_by_state.NY, 3_100); assert.equal(s.residents_by_state.TX, 2_000);
  assert.deepEqual([s.ftc.required, s.ftc.due, s.ftc.internal_target, s.ftc.timer?.code], [true, D("2026-11-15"), D("2026-11-13"), "FTC_314_4J_NOTIFICATION_EVENT_30D"]);
  const ny = s.states.find((x) => x.state === "NY")!; assert.deepEqual([ny.consumer_due, ny.ag_due, ny.cra_due], [D("2026-11-15"), D("2026-11-15"), null]);
  assert.deepEqual(ny.timers.map((t) => t.code), ["STATE_BREACH_CONSUMER_NOTICE_NY_30D", "STATE_BREACH_REGULATOR_NOTICE_NY"]);
  const tx = s.states.find((x) => x.state === "TX")!; assert.deepEqual([tx.consumer_due, tx.ag_due], [D("2026-12-15"), D("2026-11-15")]);   // [UNVERIFIED TX terms] per spec
  assert.deepEqual(s.refused_states, ["OH"]); assert.ok(s.escalations.some((e) => e.kind === "attorney" && e.within_minutes === 60));
  assert.ok(s.nydfs_prong1_met, "FTC/state-AG notice required → NYDFS prong (1) met"); assert.ok(s.escalations.some((e) => e.kind === "human_portal_task" && e.owner_role === "officer"));
  const cra = scopeIncident({ discovered_on: D("2026-10-16"), persons: persons(5_001, "NY", true, true) });
  assert.equal(cra.unencrypted_customer_info_acquired, "presumed"); assert.equal(cra.states[0]!.cra_due, D("2026-11-15"));
  assert.equal(scopeIncident({ discovered_on: D("2026-10-16"), persons: persons(5_000, "NY", true, true) }).states[0]!.cra_due, null);   // "more than five thousand" (§899-aa(8)(b)); ./incident.ts stateNotices uses >= — see notes
  const detected = zonedEpochMs(D("2026-11-02"), "09:00", ET);
  assert.deepEqual([wallClock(vulnRemediationDueMs(detected, "critical", true), ET).date, wallClock(vulnRemediationDueMs(detected, "critical", true), ET).hour], [D("2026-11-05"), 9]);
  assert.equal(wallClock(vulnRemediationDueMs(detected, "high", false), ET).date, D("2026-12-02"));   // high 30 d (./incident.ts vulnSlaMs says 14 d — see notes)
  assert.equal(wallClock(vulnRemediationDueMs(detected, "low", false), ET).date, D("2027-05-01"));   // low 180 d
  // containment and control tests behind the tools
  assert.equal(containmentAction({ targets: Array.from({ length: 51 }, (_, i) => `u${i}`), ciso_approved: false }).pending, "ciso");
  assert.match(containmentAction({ targets: ["u-break-glass-1"], ciso_approved: true }).refusal!, /break-glass/);
  const mfa = mfaControlTest([{ id: "h1", kind: "human", mfa_method: "fido2", privileged: true }, { id: "h2", kind: "human", mfa_method: null }, { id: "s1", kind: "system", mfa_method: null }], CONFIRMED);
  assert.equal(mfa.result, "fail"); assert.deepEqual(mfa.actions, [{ action: "idp.disableIdentity", target: "h2", by_ms: CONFIRMED + 15 * 60_000 }]); assert.deepEqual(mfa.board_report_items, ["CTL-SEC-01 fail: h2 without MFA"]);
  assert.equal(mfaControlTest([{ id: "h2", kind: "human", mfa_method: null, exception_approved: true }], CONFIRMED).result, "exception");
  const tls = tlsControlTest(["ECDHE-RSA-AES256-GCM-SHA384", "AES256-SHA"], D("2026-10-22"));
  assert.equal(tls.result, "fail"); assert.equal(tls.escalation?.kind, "sev1"); assert.ok(tls.before_cutoff); assert.equal(tls.cutoff, D("2026-10-23"));
  assert.equal(EVALUATORS_19_2["19.2.tlsProfileEcdheGcmOnly"]!({ ciphers: ["ECDHE-RSA-AES256-GCM-SHA384", "AES256-SHA"] }).open, false); assert.equal(EVALUATORS_19_2["19.2.tlsProfileEcdheGcmOnly"]!({ ciphers: ["ECDHE-ECDSA-AES128-GCM-SHA256"] }).open, true);
  assert.equal(exceptionProposal({ control_code: "CTL-SEC-01", scope: "fax gateway", justification: "legacy", compensating_controls: "network isolation", proposed_on: D("2026-10-01"), expires_on: D("2027-12-01") }).refusal !== null, true);
  assert.match(exceptionProposal({ control_code: "CTL-SEC-01", scope: "fax gateway", justification: "legacy", compensating_controls: "network isolation", proposed_on: D("2026-10-01"), expires_on: D("2027-03-31"), approve: true }).refusal!, /only the Qualified Individual approves/);
});
