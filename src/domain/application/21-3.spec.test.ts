// 21.3 Companion early disclosures: homeownership counseling list, Your Home Loan Toolkit, AfBA, Reg B appraisal notice, FCRA/Reg V credit-score notices, ARM program disclosure and CHARM booklet, GLBA initial privacy notice, the retired RESPA Servicing Disclosure Statement, and state early disclosures
// spec/sections/21-application-urla-initial-disclosures-intent-to-proceed-rate/21-3-companion-early-disclosures-homeownership-counseling-list-yo.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { levelPayment, ratePercent } from "../../kernel/money/index.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EscalationService } from "../../app/escalations.ts";
import { assertGate, evaluateGate, GateClosed } from "../../app/evaluators.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { TOOLS_21_3 } from "../../app/tools/section21-3.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { PHOENIX_CREDITOR, COLUMBUS_CREDITOR, civilDate, type CreditorCalendarSpec, type EsignConsent } from "./ops-21-2.ts";
import { CompanionDisclosureService, CompanionRefused, CompanionGateClosed, companionDueAt, standaloneNoticeBy, counselingZip, generateCounselingList, counselingListFreshness, counselingListPayload, regBSatisfaction, toolkitRequirement, toolkitEditions, scoreDisclosureFor, scoreNoticeGate, armIllustration, armProgramDisclosure, armPlan, formatCentsUsd, afbaRelationship, afbaReferralGate, validateRequiredUse, afbaStatementPayload, evaluateStateMatrix, stateAcknowledgmentGate, HCL_AGENCY_COUNT, HCL_FIELDS, HCL_ACCOMPANYING_LANGUAGE, HCL_LANGUAGE_VERSION, HCL_MAX_AGE_DAYS, C9_TEXT, FCRA_609G_NOTICE_TEXT, H3_ELEMENTS, MAX_KEY_FACTORS, TOOLKIT_EDITION, CHARM_EDITION, PRIVACY_EDITION, SDS_SCOPE, TIMER_CODES, type HudSnapshot, type CreditReportReceived, type AffiliateRelationship, type ArmProgramDisclosure, type PlanInput, type Borrower, type CompanionGateCode } from "./ops-21-3.ts";

const INTAKE: Actor = { kind: "agent", id: "intake" };
const DISCLOSURE: Actor = { kind: "agent", id: "disclosure" };
const MST = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-07:00`).toISOString();
const EDT = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-04:00`).toISOString();
/** Refinance fixture (Phoenix, AZ; worked example 1): E-SIGN consent Oct 5 10:20 MST (20.3). */
const CONSENT: EsignConsent = { id: "CNS-ESIGN-1", scope: ["disclosures", "notices"], granted_at: MST("2026-10-05", "10:20") };
/** Purchase fixture (Columbus, OH; worked example 2): consent at the Oct 19 18:45 EDT start. */
const CONSENT_B: EsignConsent = { id: "CNS-ESIGN-2", scope: ["disclosures", "notices"], granted_at: EDT("2026-10-19", "18:45") };
const BORROWER_A: Borrower = { id: "B-A", name: "Borrower A", current_address_zip5: "85018", current_address_country: "US", primary: true };
const BORROWER_A_OH: Borrower = { id: "B-A", name: "Borrower A", current_address_zip5: "43215", current_address_country: "US", primary: true };
const BORROWER_B_OH: Borrower = { id: "B-B", name: "Borrower B", current_address_zip5: "43215", current_address_country: "US" };
const LENDER = { name: "Lender 1", nmlsr_id: "000001", address: "Lender Address 1" };
const SCORE_GATE: CompanionGateCode = "REGV_1022_74D_SCORE_NOTICE_CONSUMMATION_GATE";
const ARM_GATE: CompanionGateCode = "REGZ_1026_19B_ARM_DISCLOSURE_GATE";
/** A HUD Housing Counselor API snapshot: `n` agencies with the eleven fields, distances deliberately out of order (1, 8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6 miles). */
const hud = (snapshot_at: string, n = 12): HudSnapshot => ({ snapshot_at, centroid: { lat: "33.5", long: "-112.0" }, agencies: Array.from({ length: n }, (_, k) => ({ agency_name: `Agency ${k + 1}`, phone: `555-01${String(k).padStart(2, "0")}`, street_address: `Street Address ${k + 1}`, street_address_2: "", city: "City 1", state: "AZ", zip: "85018", website: `site ${k + 1}`, email: `email ${k + 1}`, services: "Pre-purchase counseling", languages: "English; Spanish", distance_miles: String(((k * 7) % 12) + 1) })) });
/** 22.2's per-borrower score payload (one representative score per report in the purchase fixture; `factors` key factors, `inquiries` = inquiries are one of them). */
const report = (application_id: string, application_borrower_id: string, borrower_name: string, credit_report_id: string, received_at: string, score: number, factors: number, inquiries: boolean): CreditReportReceived =>
  ({ application_id, application_borrower_id, borrower_name, credit_report_id, received_at, scores: [{ cra: "CRA2", cra_contact: "CRA 2, Address 2, 555-0102", model: "Classic FICO", score, range_low: 300, range_high: 850, date: D("2026-10-20"), key_factors: Array.from({ length: factors }, (_, k) => `Key factor ${k + 1}`), inquiries_factor: inquiries, representative: true, distribution: [{ label: "300-579", pct: 16 }, { label: "580-669", pct: 17 }, { label: "670-739", pct: 21 }, { label: "740-799", pct: 25 }, { label: "800-850", pct: 21 }] }] });

/** The 21.3 lifecycle on the event store: `CompanionDisclosureService` (the process's command surface), the EscalationService the gates escalate on, and the TimerEngine arming the 21.3 rows from the events 21.1/22.2/23.4/24.x raise. */
function harness(nowIso: string, calendar: CreditorCalendarSpec = PHOENIX_CREDITOR, deps: { rels?: AffiliateRelationship[] } = {}) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["21.3"] });
  const escalations = new EscalationService(events, clock);
  const svc = new CompanionDisclosureService({ events, clock, escalations, calendar, timers, affiliate_relationships: deps.rels ?? [], referring_party_ids: ["partner", "sm"] });
  const tz = calendar.time_zone;
  const ev = (type: string, applicationId: string, at: string, payload: Record<string, unknown>) => events.append({ type, applicationId, aggregate: { kind: "application", id: applicationId }, actor: INTAKE, occurredAt: at, payload: { application_id: applicationId, source: "origination", ...payload } });
  /** 21.1 `application.started` (the pre-application state gates arm here). */
  const started = (applicationId: string, at: string, s: { property_state?: string | null; interview_language?: string | null; intake_channel?: string }) => {
    clock.set(at); const r = svc.onApplicationStarted(applicationId, { at, property_state: s.property_state ?? null, interview_language: s.interview_language ?? null });
    ev("application.started", applicationId, at, { started_at: at, property_state: s.property_state ?? null, intake_channel: s.intake_channel ?? "web" }); svc.cancelInapplicableStateGates(applicationId); return r;
  };
  /** 21.1 `application.received` (Reg B application): the companion plan and the three application-anchored clocks. */
  const received = (applicationId: string, at: string, p: Partial<PlanInput> & { transaction_type: string }) => {
    clock.set(at); const r = svc.planCompanionPackage({ application_id: applicationId, application_received_at: at, borrowers: [BORROWER_A], ...p });
    ev("application.received", applicationId, at, { application_received_at: at, application_date: civilDate(at, tz), transaction_type: p.transaction_type, property_state: p.property_state ?? null }); svc.cancelInapplicableStateGates(applicationId); return r;
  };
  /** 21.1 `application.trid_received` (six items): the Toolkit and CA §1632.5 anchors. */
  const trid = (applicationId: string, at: string, t: { transaction_type: string; property_state?: string | null; interview_language?: string | null }) => {
    clock.set(at); const r = svc.onTridReceived(applicationId, { trid_received_at: at, transaction_type: t.transaction_type, ...(t.property_state !== undefined ? { property_state: t.property_state } : {}), ...(t.interview_language !== undefined ? { interview_language: t.interview_language } : {}) });
    ev("application.trid_received", applicationId, at, { trid_received_at: at, trid_application_date: civilDate(at, tz), transaction_type: t.transaction_type, property_state: t.property_state ?? null, interview_language: t.interview_language ?? "en" }); return r;
  };
  /** 21.1/20.4 `application.arm_interest.recorded{fnma_plan_number, channel}` (defined by 21.3). */
  const armInterest = (applicationId: string, at: string, fnma_plan_number: string, channel: "electronic" | "telephone" | "in_person") => {
    clock.set(at); const r = svc.recordArmInterest(applicationId, { fnma_plan_number, channel, at }); ev("application.arm_interest.recorded", applicationId, at, { fnma_plan_number, channel }); return r;
  };
  const emitted = (type: string) => events.all().filter((e) => e.type === type);
  const timer = (code: string, applicationId?: string) => timers.byCode(code).filter((t) => !applicationId || t.applicationId === applicationId).at(-1)!;
  return { clock, events, timers, escalations, svc, started, received, trid, armInterest, emitted, timer };
}
/** The process's bus tools bound to the harness (services.companion = the service; the agent never calls the service directly). */
function bindTools(h: ReturnType<typeof harness>, applicationId: string) {
  const agents = new AgentRegistry(); const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const rt: ToolRuntime = { store: new EntityStore(), ports: {}, escalations: h.escalations, services: { companion: h.svc } };
  const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of TOOLS_21_3) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(d.name, cmd); }
  const bus = new CommandBus(agents);
  const ctx: UowContext = { loanId: "", applicationId, events: h.events, ledger: new MemoryLedger(), timers: h.timers, clock: h.clock, decide: () => {} };
  return { run: (name: string, input: ToolInput) => bus.execute(cmds.get(name)!, DISCLOSURE, input, ctx), names: [...cmds.keys()] };
}
/** The Notice Registry with 21.3's authored versions published (effective 2026-09-01). */
const registry = () => { const reg = buildRegistry(); publishAuthored(reg); return reg; };
/** The NTC_REGZ_1026_19B_ARM_PROGRAM template payload from the process's program disclosure (rule 7). */
const armTemplatePayload = (d: ArmProgramDisclosure): Record<string, unknown> => ({ plan_label: `${d.label} ARM`, fnma_plan_number: d.fnma_plan_number, index_name: "30-day Average SOFR", index_code: "sofr_30d_avg", index_source: "Index Source 1", lookback_days: d.lookback_days, discounted: false, initial_fixed_months: armPlan(d.fnma_plan_number).initial_fixed_months, adjustment_period_months: 6,
  cap_first_pct: d.caps.first, cap_subsequent_pct: d.caps.subsequent, cap_lifetime_pct: d.caps.lifetime, initial_rate_pct: d.illustration.initial_rate_pct, illustration_as_of: "October 2026", initial_payment_cents: d.illustration.initial_payment_cents, max_rate_pct: d.illustration.max_rate_pct, months_to_max: d.illustration.months_to_max_rate, max_payment_cents: d.illustration.max_payment_cents, first_notice_days_min: 210, later_notice_days_min: 60 });

test("21.3-T1: Given `application_received_at` = Mon Oct 5, 2026 10:16 MST and calendar `creditor` (Mon–Fri, Oct 12 closed), when the plan is created, then `REGX_1024_20_HCL_3BD`, `REGB_1002_14_APPRAISAL_NOTICE_3BD` and `SM_O23_PRIVACY_INITIAL_3BD` show `due_at` = Thu Oct 8, 2026 23:59 MST; with `application_received_at` = Thu Oct 8 the due date is Wed Oct 14 (Tue Oct 13 with `saturday_open=true` or Columbus Day open).", () => {
  const at = MST("2026-10-05", "10:16"); const h = harness(at);
  const p = h.received("APP-T1", at, { transaction_type: "limited_cash_out", property_state: "AZ", property_zip5: "85018" });
  assert.equal(p.package.package_id, "PKG-APP-T1"); assert.equal(p.package.status, "assembling"); assert.equal(h.emitted("disclosure.companion.planned")[0]!.payload.package_id, "PKG-APP-T1");
  for (const [kind, code] of [["hcl", "REGX_1024_20_HCL_3BD"], ["regb_appraisal_notice", "REGB_1002_14_APPRAISAL_NOTICE_3BD"], ["privacy", "SM_O23_PRIVACY_INITIAL_3BD"]] as const) {
    const r = p.rows.find((x) => x.kind === kind)!; assert.equal(r.timer_code, code); assert.equal(r.due_at, MST("2026-10-08", "23:59"), code); assert.equal(r.calendar_code, "creditor"); assert.equal(r.status, "planned"); assert.equal(r.anchor_event, "application.received"); assert.equal(r.anchor_at, at);
    const t = h.timer(code, "APP-T1"); assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-05"); assert.equal(t.dueDate, "2026-10-08"); assert.equal(t.applicationId, "APP-T1");
  }
  assert.equal(new Date(p.rows.find((x) => x.kind === "hcl")!.due_at!).toISOString(), "2026-10-09T06:59:00.000Z");   // 23:59 MST
  assert.deepEqual([1, 2, 3].map((n) => companionDueAt(at, n, PHOENIX_CREDITOR).due_on), ["2026-10-06", "2026-10-07", "2026-10-08"]);   // Tue 6, Wed 7, Thu 8
  assert.equal(companionDueAt(at, 0, PHOENIX_CREDITOR).due_on, "2026-10-05");   // same-day rules resolve to the end of the anchor day
  // Columbus Day case (worked example 2(b)): Fri 9, (Sat/Sun, Mon Oct 12 closed), Tue 13, Wed 14
  const thu = MST("2026-10-08", "09:00");
  const base = companionDueAt(thu, 3, PHOENIX_CREDITOR); assert.equal(base.anchor_on, "2026-10-08"); assert.equal(base.due_on, "2026-10-14"); assert.equal(base.due_at, MST("2026-10-14", "23:59"));
  assert.equal(companionDueAt(thu, 3, { ...PHOENIX_CREDITOR, saturday_open: true }).due_on, "2026-10-13");                     // Fri 9, Sat 10, Tue 13
  assert.equal(companionDueAt(thu, 3, { ...PHOENIX_CREDITOR, open_on_holidays: [D("2026-10-12")] }).due_on, "2026-10-13");    // Fri 9, Mon 12, Tue 13
  const g = harness(thu); const q = g.received("APP-T1b", thu, { transaction_type: "limited_cash_out", property_state: "AZ" });
  for (const kind of ["hcl", "regb_appraisal_notice", "privacy"] as const) assert.equal(q.rows.find((x) => x.kind === kind)!.due_at, MST("2026-10-14", "23:59"), kind);
  assert.equal(g.timer("REGX_1024_20_HCL_3BD", "APP-T1b").dueDate, "2026-10-14"); assert.equal(g.timer("SM_O23_PRIVACY_INITIAL_3BD", "APP-T1b").dueDate, "2026-10-14");
  const sat = harness(thu, { ...PHOENIX_CREDITOR, saturday_open: true }); assert.equal(sat.received("APP-T1c", thu, { transaction_type: "limited_cash_out", property_state: "AZ" }).rows.find((x) => x.kind === "privacy")!.due_at, MST("2026-10-13", "23:59"));
  // the plan through the bus tool: the same rows and clocks (`setTimers` lists them next to the engine's instances)
  const tools = bindTools(h, "APP-T1"); assert.deepEqual(tools.names, loadAgentsFile().processes.find((x) => x.process === "21.3")!.tools);
  return tools.run("setTimers", { application_id: "APP-T1", anchor_at: at }).then((r) => { const o = r.output as { rows: { rule_code: string; due_at: string | null; engine: { id: string; status: string; due_date: string | null; note: string | null }[] }[]; preview: { due: { business_days: number; due_on: string }[] } };
    const hcl = o.rows.find((x) => x.rule_code === "REGX_1024_20")!; assert.equal(hcl.due_at, MST("2026-10-08", "23:59")); assert.deepEqual(hcl.engine, [{ id: hcl.engine[0]!.id, status: "armed", due_date: "2026-10-08", note: null }]);
    assert.deepEqual(o.preview.due.map((d) => [d.business_days, d.due_on]), [[0, "2026-10-05"], [1, "2026-10-06"], [3, "2026-10-08"]]); });
});
test("21.3-T2: Given HUD data obtained Sat Sept 5, 2026 and a delivery attempted Tue Oct 6, 2026, when `deliver{hcl}` runs, then the list is refused as stale (31 calendar days) and regenerated; data obtained Sun Sept 6 (30 days) is accepted.", () => {
  const h = harness(MST("2026-10-05", "10:16")); h.received("APP-T2", MST("2026-10-05", "10:16"), { transaction_type: "limited_cash_out", property_state: "AZ", property_zip5: "85018" });
  const stale = h.svc.generateCounselingList("APP-T2", { hud: hud(MST("2026-09-05", "15:31")), at: MST("2026-10-05", "15:31") });
  assert.equal(stale.row.status, "generated"); assert.equal(stale.list.hud_snapshot_at, MST("2026-09-05", "15:31")); assert.equal(stale.row.data_snapshot_id, stale.list.list_id);
  const f = counselingListFreshness(MST("2026-09-05", "15:31"), MST("2026-10-06", "09:00"), "America/Phoenix"); assert.equal(f.age_days, 31); assert.equal(f.fresh, false); assert.equal(HCL_MAX_AGE_DAYS, 30);
  h.clock.set(MST("2026-10-06", "09:00"));
  assert.throws(() => h.svc.deliver("APP-T2", { kind: "hcl", channel: "esign_portal", consent: CONSENT }), (e: unknown) => e instanceof CompanionRefused && e.code === "STALE_COUNSELING_LIST" && /31 calendar days/.test(e.reason) && /1024\.20\(a\)\(1\)/.test(e.reason));
  const refused = h.emitted("disclosure.companion.delivery.refused"); assert.equal(refused.length, 1); assert.equal(refused[0]!.payload.code, "STALE_COUNSELING_LIST"); assert.equal(refused[0]!.payload.kind, "hcl");
  assert.equal(h.svc.get(stale.row.disclosure_id).status, "planned"); assert.equal(h.svc.get(stale.row.disclosure_id).delivered_at, null); assert.equal(h.timer("REGX_1024_20_HCL_3BD", "APP-T2").status, "armed");
  // regenerated from data obtained Sun Sept 6: 30 calendar days on Oct 6 — accepted; the prior list is superseded
  const fresh = h.svc.generateCounselingList("APP-T2", { hud: hud(MST("2026-09-06", "08:00")), at: MST("2026-10-06", "09:05") });
  assert.equal(stale.list.superseded_by_list_id, fresh.list.list_id); assert.equal(fresh.list.superseded_by_list_id, null); assert.equal(h.svc.counselingList("APP-T2")!.list_id, fresh.list.list_id); assert.equal(h.svc.counseling_lists.length, 2);
  const g2 = h.emitted("counseling_list.generated"); assert.equal(g2.length, 2); assert.equal(g2[1]!.payload.superseded_list_id, stale.list.list_id); assert.equal(g2[1]!.payload.hud_snapshot_at, MST("2026-09-06", "08:00"));
  assert.deepEqual(counselingListFreshness(MST("2026-09-06", "08:00"), MST("2026-10-06", "09:10"), "America/Phoenix"), { age_days: 30, fresh: true });
  h.clock.set(MST("2026-10-06", "09:10"));
  const row = h.svc.deliver("APP-T2", { kind: "hcl", channel: "esign_portal", consent: CONSENT });
  assert.equal(row.status, "delivered"); assert.equal(row.delivered_at, MST("2026-10-06", "09:10")); assert.equal(row.data_snapshot_id, fresh.list.list_id); assert.equal(row.delivery_channel, "esign_portal"); assert.equal(row.esign_consent_id, "CNS-ESIGN-1");
  assert.equal(h.timer("REGX_1024_20_HCL_3BD", "APP-T2").status, "satisfied"); assert.equal(h.timer("REGX_1024_20_HCL_3BD", "APP-T2").satisfiedAt, MST("2026-10-06", "09:10"));
  assert.equal(h.emitted("disclosure.companion.delivered")[0]!.payload.kind, "hcl"); assert.equal(h.emitted("disclosure.companion.issued")[0]!.payload.rule_code, "REGX_1024_20");
  // a short list is never delivered either (rule 3): nine agencies from the HUD API
  const s = harness(MST("2026-10-05", "10:16")); s.received("APP-T2b", MST("2026-10-05", "10:16"), { transaction_type: "limited_cash_out", property_state: "AZ" });
  assert.throws(() => s.svc.generateCounselingList("APP-T2b", { hud: hud(MST("2026-10-05", "15:31"), 9), at: MST("2026-10-05", "15:31") }), (e: unknown) => e instanceof RangeError && /9 agencies/.test(e.message));
  assert.throws(() => s.svc.deliver("APP-T2b", { kind: "hcl", channel: "esign_portal", consent: CONSENT, at: MST("2026-10-05", "16:10") }), (e: unknown) => e instanceof CompanionRefused && e.code === "NO_LIST");
});
test("21.3-T3: Given zip 85018 for the applicant's current address, when `generateCounselingList` runs, then exactly 10 agencies with the eleven data fields, sorted by distance from the zip centroid, and the accompanying language verbatim appear on the rendered list; an applicant with a foreign current address yields `zip_source='property_address_overseas'`.", async () => {
  const h = harness(MST("2026-10-05", "15:31")); h.received("APP-T3", MST("2026-10-05", "10:16"), { transaction_type: "limited_cash_out", property_state: "AZ", property_zip5: "85254" });
  const { list, row } = h.svc.generateCounselingList("APP-T3", { hud: hud(MST("2026-10-05", "15:31")), at: MST("2026-10-05", "15:31") });
  assert.equal(list.zip_used, "85018"); assert.equal(list.zip_source, "current_address"); assert.equal(list.application_borrower_id, "B-A"); assert.equal(list.hud_snapshot_at, MST("2026-10-05", "15:31"));
  assert.equal(list.agencies.length, HCL_AGENCY_COUNT); assert.equal(list.agencies.length, 10); assert.equal(HCL_FIELDS.length, 11);
  for (const a of list.agencies) for (const f of HCL_FIELDS) assert.equal(typeof a[f], "string", `${a.agency_name} ${f}`);
  const dist = list.agencies.map((a) => Number(a.distance_miles)); assert.deepEqual(dist, [...dist].sort((x, y) => x - y)); assert.deepEqual(dist, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);   // the two farthest of twelve are dropped
  assert.equal(list.accompanying_language, HCL_ACCOMPANYING_LANGUAGE); assert.equal(list.accompanying_language_version, HCL_LANGUAGE_VERSION); assert.match(list.accompanying_language, /approved by the U\.S\. Department of Housing and Urban Development \(HUD\)/);
  assert.equal(row.status, "generated"); assert.equal(row.rendered_document_id, `DOC-HCL-${list.list_id}`); assert.equal(row.generated_at, MST("2026-10-05", "15:31"));
  const ev = h.emitted("counseling_list.generated")[0]!; assert.equal(ev.payload.zip_used, "85018"); assert.equal(ev.payload.zip_source, "current_address"); assert.equal(ev.payload.agency_count, 10);
  // the rendered list: the process payload carries the ten ranked agencies, the eleven fields and the language verbatim
  const payload = counselingListPayload(list, { applicant_name: "Borrower A", lender_name: LENDER.name, lender_nmlsr_id: LENDER.nmlsr_id, application_id: "APP-T3" });
  assert.equal(payload.agency_count, 10); assert.equal(payload.field_count, 11); assert.deepEqual((payload.agencies as { rank: number }[]).map((a) => a.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); assert.equal(payload.accompanying_language, HCL_ACCOMPANYING_LANGUAGE); assert.equal(payload.generated_on, "2026-10-05");
  const tools = bindTools(h, "APP-T3"); const rn = (await tools.run("renderNotice", { application_id: "APP-T3", kind: "hcl", applicant_name: "Borrower A", lender: LENDER })).output as { template_code: string; payload: { agency_count: number } };
  assert.equal(rn.template_code, "NTC_REGX_1024_20_HCL"); assert.equal(rn.payload.agency_count, 10);
  // NTC_REGX_1024_20_HCL in the Notice Registry: the list passes the template's own checklist (ten agencies, eleven fields, freshness, zip source, the accompanying language)
  const v = registry().activeVersion("NTC_REGX_1024_20_HCL", D("2026-10-05")); assert.ok(v, "NTC_REGX_1024_20_HCL authored");
  const tpl = { lender_name: LENDER.name, lender_nmlsr_id: LENDER.nmlsr_id, applicant_name: "Borrower A", application_id: "APP-T3", prepared_on: payload.generated_on, hud_snapshot_date: civilDate(list.hud_snapshot_at, "America/Phoenix"), snapshot_age_days: counselingListFreshness(list.hud_snapshot_at, MST("2026-10-05", "16:10"), "America/Phoenix").age_days, zip_used: list.zip_used, zip_source: list.zip_source, zip_source_label: "your current address", current_address_zip5: "85018", agency_count: list.agencies.length, cfpb_phone: "555-0101",
    agencies: list.agencies.map((a) => ({ name: a.agency_name, phone: a.phone, street: a.street_address, street2: a.street_address_2, city: a.city, state: a.state, zip: a.zip, website: a.website, email: a.email, services: a.services, languages: a.languages })) };
  const rendered = render(v!.source, tpl); const check = evaluateChecklist(v!, tpl, rendered); assert.deepEqual(check.blocking.map((b) => b.rule_id), []); assert.equal(check.passed, true);
  assert.equal((rendered.text.match(/Agency name: /g) ?? []).length, 10);
  // the zip rule (rule 3): current address → mailing address → property zip only when the current address has no five-digit zip (overseas)
  assert.deepEqual(counselingZip({ current_address_zip5: "85018", current_address_country: "US" }, "85254"), { zip_used: "85018", zip_source: "current_address" });
  assert.deepEqual(counselingZip({ current_address_zip5: null, mailing_address_zip5: "85254" }, "85018"), { zip_used: "85254", zip_source: "mailing_address" });
  assert.deepEqual(counselingZip({ current_address_zip5: null, current_address_country: "GB" }, "85018"), { zip_used: "85018", zip_source: "property_address_overseas" });
  assert.deepEqual(counselingZip({ current_address_zip5: "SW1A 1AA", current_address_country: "GB" }, "85018"), { zip_used: "85018", zip_source: "property_address_overseas" });
  assert.throws(() => counselingZip({ current_address_zip5: null, current_address_country: "GB" }, null), RangeError);
  const g = harness(MST("2026-10-05", "15:31")); g.received("APP-T3b", MST("2026-10-05", "10:16"), { transaction_type: "purchase", property_state: "AZ", property_zip5: "85018", borrowers: [{ id: "B-X", name: "Borrower X", current_address_zip5: null, current_address_country: "GB", primary: true }] });
  const abroad = g.svc.generateCounselingList("APP-T3b", { hud: hud(MST("2026-10-05", "15:31")), at: MST("2026-10-05", "15:31") });
  assert.equal(abroad.list.zip_source, "property_address_overseas"); assert.equal(abroad.list.zip_used, "85018"); assert.equal(g.emitted("counseling_list.generated")[0]!.payload.zip_source, "property_address_overseas");
  assert.throws(() => generateCounselingList({ application_id: "APP-T3", zip_used: "8501", zip_source: "current_address", hud: hud(MST("2026-10-05", "15:31")), generated_at: MST("2026-10-05", "15:31") }), RangeError);
  // guardrail on the bus: the property zip is never used while a current-address zip exists
  await assert.rejects(tools.run("generateCounselingList", { application_id: "APP-T3", hud: hud(MST("2026-10-05", "15:31")), zip_source: "property_address_overseas", current_address_zip5: "85018" }), (e: unknown) => e instanceof CommandRefused && e.code === "HCL_PROPERTY_ZIP_WITH_CURRENT");
  await assert.rejects(tools.run("generateCounselingList", { application_id: "APP-T3", hud: hud(MST("2026-10-05", "15:31"), 9) }), (e: unknown) => e instanceof CommandRefused && e.code === "HCL_SHORT_LIST");
});
test("21.3-T4: Given LE v1 delivered Mon Oct 5 16:10 MST, when the Reg B row is evaluated, then `satisfied_by_disclosure_id` = LE v1 and state `satisfied_by_le`; given instead a Reg B application Mon Oct 19 with no property (TBD purchase) and no LE by Thu Oct 22 19:59 EDT, then the standalone `NTC_REGB_1002_14_APPRAISAL_NOTICE` is delivered by 19:59 (due − 4 h) and the timer is satisfied.", () => {
  const h = harness(MST("2026-10-05", "10:16")); const p = h.received("APP-T4", MST("2026-10-05", "10:16"), { transaction_type: "limited_cash_out", property_state: "AZ" });
  const regb = p.rows.find((r) => r.kind === "regb_appraisal_notice")!; assert.equal(regb.rule_code, "REGB_1002_14A2"); assert.equal(regb.due_at, MST("2026-10-08", "23:59")); assert.equal(regb.standalone_issue_by, MST("2026-10-08", "19:59")); assert.equal(regb.retention_class, "regb_25m"); assert.equal(regb.notice_code, "NTC_REGB_1002_14_APPRAISAL_NOTICE");
  h.clock.set(MST("2026-10-05", "16:10"));
  const r = h.svc.markSatisfiedByLE("APP-T4", { disclosure_id: "LE-1", le_version: 1, delivered_at: MST("2026-10-05", "16:10"), mailed_at: null });
  assert.equal(r.satisfied_by_le, true); assert.equal(r.le_out, MST("2026-10-05", "16:10")); assert.equal(r.regb.status, "satisfied_by_le"); assert.equal(r.regb.satisfied_by_disclosure_id, "LE-1"); assert.equal(r.regb.delivered_at, null);
  assert.equal(h.timer("REGB_1002_14_APPRAISAL_NOTICE_3BD", "APP-T4").status, "satisfied"); assert.equal(h.timer("REGB_1002_14_APPRAISAL_NOTICE_3BD", "APP-T4").satisfiedAt, MST("2026-10-05", "16:10"));
  const sat = h.emitted("disclosure.companion.satisfied_by_le")[0]!; assert.equal(sat.payload.le_disclosure_id, "LE-1"); assert.equal(sat.payload.rule_code, "REGB_1002_14A2"); assert.equal(sat.payload.due_at, regb.due_at);
  assert.equal(h.emitted("disclosure.companion.issued")[0]!.payload.via, "le"); assert.equal(h.svc.package("APP-T4").le_disclosure_id, "LE-1"); assert.equal(h.svc.package("APP-T4").items.find((i) => i.disclosure_id === regb.disclosure_id)!.satisfied_by, "le");
  assert.equal(h.svc.standaloneRegBNoticeDue("APP-T4", MST("2026-10-08", "19:59")).due, false);
  // rule 4: le_out = min(delivered_at, mailed_at); an LE out after due_at is not the notice
  assert.equal(regBSatisfaction({ disclosure_id: "LE-late", delivered_at: MST("2026-10-09", "09:00"), mailed_at: null }, regb.due_at!).satisfied_by_le, false);
  assert.deepEqual(regBSatisfaction({ disclosure_id: "LE-m", delivered_at: null, mailed_at: MST("2026-10-08", "23:00") }, regb.due_at!), { satisfied_by_le: true, le_out: MST("2026-10-08", "23:00"), satisfied_by_disclosure_id: "LE-m" });
  assert.equal(regBSatisfaction({ disclosure_id: "LE-x", delivered_at: MST("2026-10-09", "09:00"), mailed_at: MST("2026-10-08", "12:00") }, regb.due_at!).le_out, MST("2026-10-08", "12:00"));
  assert.equal(regBSatisfaction(null, regb.due_at!).satisfied_by_le, false);
  // property TBD purchase (Columbus fixture): Reg B application Mon Oct 19 18:40 EDT, no LE — the standalone C-9 notice by due_at − 4h
  const g = harness(EDT("2026-10-19", "18:40"), COLUMBUS_CREDITOR); const q = g.received("APP-T4b", EDT("2026-10-19", "18:40"), { transaction_type: "purchase", property_state: null, borrowers: [BORROWER_A_OH, BORROWER_B_OH] });
  const row = q.rows.find((r) => r.kind === "regb_appraisal_notice")!; assert.equal(row.due_at, EDT("2026-10-22", "23:59")); assert.equal(row.standalone_issue_by, EDT("2026-10-22", "19:59")); assert.equal(standaloneNoticeBy(row.due_at!), EDT("2026-10-22", "19:59"));
  assert.equal(g.timer("REGB_1002_14_APPRAISAL_NOTICE_3BD", "APP-T4b").dueDate, "2026-10-22"); assert.equal(g.timers.byCode("REGZ_1026_19G_TOOLKIT_3BD").length, 0);   // the Toolkit waits for the six items
  assert.equal(g.svc.standaloneRegBNoticeDue("APP-T4b", EDT("2026-10-22", "10:00")).due, false);
  const due = g.svc.standaloneRegBNoticeDue("APP-T4b", EDT("2026-10-22", "19:59")); assert.equal(due.due, true); assert.equal(due.issue_by, EDT("2026-10-22", "19:59")); assert.equal(due.row!.standalone_required, true);
  g.clock.set(EDT("2026-10-22", "19:59"));
  const std = g.svc.deliver("APP-T4b", { kind: "regb_appraisal_notice", channel: "esign_portal", consent: CONSENT_B });
  assert.equal(std.notice_code, "NTC_REGB_1002_14_APPRAISAL_NOTICE"); assert.equal(std.status, "delivered"); assert.equal(std.delivered_at, EDT("2026-10-22", "19:59")); assert.ok(Date.parse(std.delivered_at!) <= Date.parse(row.standalone_issue_by!)); assert.equal(std.satisfied_by_disclosure_id, null);
  assert.equal(g.timer("REGB_1002_14_APPRAISAL_NOTICE_3BD", "APP-T4b").status, "satisfied"); assert.equal(g.emitted("disclosure.companion.issued").find((e) => e.payload.rule_code === "REGB_1002_14A2")!.payload.via, "delivered");
  assert.equal(g.svc.standaloneRegBNoticeDue("APP-T4b", EDT("2026-10-22", "20:30")).due, false); assert.match(C9_TEXT, /We may order an appraisal to determine the property's value and charge you for this appraisal/);
  assert.ok(registry().activeVersion("NTC_REGB_1002_14_APPRAISAL_NOTICE", D("2026-10-22")), "NTC_REGB_1002_14_APPRAISAL_NOTICE authored");
});
test("21.3-T5: Given `transaction_type='limited_cash_out'`, then the Toolkit row is `exempt{refinance_no_toolkit}` and no `REGZ_1026_19G_TOOLKIT_3BD` timer exists; given a purchase with `trid_received_at` Mon Oct 19 20:44 EDT, then the timer is due Thu Oct 22 and is satisfied by the Oct 22 09:30 delivery of asset `2026-08`; a denial issued Wed Oct 21 cancels the timer with `denied_within_period`.", () => {
  const h = harness(MST("2026-10-05", "10:16")); h.received("APP-T5", MST("2026-10-05", "10:16"), { transaction_type: "limited_cash_out", property_state: "AZ" });
  const refi = h.trid("APP-T5", MST("2026-10-05", "10:41"), { transaction_type: "limited_cash_out" });
  assert.equal(refi.toolkit.kind, "toolkit"); assert.equal(refi.toolkit.required, false); assert.equal(refi.toolkit.status, "exempt"); assert.equal(refi.toolkit.exemption_reason, "refinance_no_toolkit"); assert.equal(refi.toolkit.timer_code, null); assert.equal(refi.toolkit.due_at, null);
  assert.equal(h.timers.byCode("REGZ_1026_19G_TOOLKIT_3BD").length, 0);
  assert.equal(h.emitted("disclosure.companion.exempt").find((e) => e.payload.rule_code === "REGZ_1026_19G")!.payload.reason, "refinance_no_toolkit");
  assert.throws(() => h.svc.deliver("APP-T5", { kind: "toolkit", channel: "esign_portal", consent: CONSENT }), (e: unknown) => e instanceof CompanionRefused && e.code === "NOT_REQUIRED");
  assert.deepEqual(toolkitRequirement("cash_out"), { required: false, exemption_reason: "refinance_no_toolkit", edition: "2026-08" }); assert.equal(toolkitRequirement("purchase").required, true); assert.equal(toolkitRequirement("purchase", false).exemption_reason, "refinance_no_toolkit"); assert.equal(toolkitRequirement("reverse").exemption_reason, "reverse_only");
  assert.deepEqual(toolkitEditions("en"), ["en"]); assert.deepEqual(toolkitEditions("es"), ["en", "es"]);
  // purchase (Columbus fixture): six items Mon Oct 19 20:44 EDT → trid_application_date Oct 19 → due Thu Oct 22 (Tue 20, Wed 21, Thu 22)
  const g = harness(EDT("2026-10-19", "18:40"), COLUMBUS_CREDITOR); g.received("APP-T5b", EDT("2026-10-19", "18:40"), { transaction_type: "purchase", property_state: "OH", borrowers: [BORROWER_A_OH, BORROWER_B_OH] });
  const pur = g.trid("APP-T5b", EDT("2026-10-19", "20:44"), { transaction_type: "purchase" });
  assert.equal(pur.toolkit.required, true); assert.equal(pur.toolkit.status, "planned"); assert.equal(pur.toolkit.anchor_event, "application.trid_received"); assert.equal(pur.toolkit.due_at, EDT("2026-10-22", "23:59")); assert.equal(pur.toolkit.asset_version, "2026-08"); assert.equal(pur.toolkit.language_edition, "en"); assert.equal(pur.toolkit.retention_class, "regz_general_2y");
  const t = g.timer("REGZ_1026_19G_TOOLKIT_3BD", "APP-T5b"); assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-19"); assert.equal(t.dueDate, "2026-10-22");
  g.clock.set(EDT("2026-10-22", "09:30"));
  assert.throws(() => g.svc.deliver("APP-T5b", { kind: "toolkit", channel: "esign_portal", consent: CONSENT_B, asset_version: "2025-01" }), (e: unknown) => e instanceof CompanionRefused && e.code === "TOOLKIT_EDITION");
  const row = g.svc.deliver("APP-T5b", { kind: "toolkit", channel: "esign_portal", consent: CONSENT_B, asset_version: "2026-08" });
  assert.equal(row.status, "delivered"); assert.equal(row.asset_version, TOOLKIT_EDITION); assert.equal(row.delivered_at, EDT("2026-10-22", "09:30"));
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedAt, EDT("2026-10-22", "09:30")); assert.equal(g.emitted("disclosure.companion.issued").find((e) => e.payload.rule_code === "REGZ_1026_19G")!.payload.asset_version, "2026-08");
  assert.ok(registry().activeVersion("NTC_REGX_1024_6_TOOLKIT", D("2026-10-22")), "NTC_REGX_1024_6_TOOLKIT authored");
  // denial Wed Oct 21 (before due_at): the Toolkit clock is cancelled with reason; the counseling list / Reg B / privacy clocks are not
  const d = harness(EDT("2026-10-19", "18:40"), COLUMBUS_CREDITOR); d.received("APP-T5c", EDT("2026-10-19", "18:40"), { transaction_type: "purchase", property_state: "OH", borrowers: [BORROWER_A_OH] });
  d.trid("APP-T5c", EDT("2026-10-19", "20:44"), { transaction_type: "purchase" });
  d.clock.set(EDT("2026-10-21", "11:00")); const c = d.svc.onDecisionIssued("APP-T5c", { outcome: "denial", at: EDT("2026-10-21", "11:00") });
  assert.equal(c.cancelled.length, 1); assert.equal(c.cancelled[0]!.kind, "toolkit"); assert.equal(c.cancelled[0]!.status, "cancelled"); assert.equal(c.cancelled[0]!.cancelled_reason, "denied_within_period");
  const tc = d.timer("REGZ_1026_19G_TOOLKIT_3BD", "APP-T5c"); assert.equal(tc.status, "cancelled"); assert.equal(tc.cancelledReason, "denied_within_period"); assert.equal(d.emitted("timer.cancel.requested")[0]!.payload.code, "REGZ_1026_19G_TOOLKIT_3BD");
  assert.equal(d.timer("REGX_1024_20_HCL_3BD", "APP-T5c").status, "armed"); assert.equal(d.timer("REGB_1002_14_APPRAISAL_NOTICE_3BD", "APP-T5c").status, "armed");
  assert.equal(d.timers.evaluate(EDT("2026-10-23", "09:00")).some((b) => b.instance.code === "REGZ_1026_19G_TOOLKIT_3BD"), false);
  assert.throws(() => d.svc.deliver("APP-T5c", { kind: "toolkit", channel: "esign_portal", consent: CONSENT_B }), (e: unknown) => e instanceof CompanionRefused && e.code === "ALREADY_TERMINAL");
  // a denial after due_at cancels nothing
  const late = harness(EDT("2026-10-19", "18:40"), COLUMBUS_CREDITOR); late.received("APP-T5d", EDT("2026-10-19", "18:40"), { transaction_type: "purchase", property_state: "OH" }); late.trid("APP-T5d", EDT("2026-10-19", "20:44"), { transaction_type: "purchase" });
  assert.equal(late.svc.onDecisionIssued("APP-T5d", { outcome: "denial", at: EDT("2026-10-23", "09:00") }).cancelled.length, 0);
});
test("21.3-T6: Given credit reports received Tue Oct 20, 2026 09:05 EDT for A (712) and B (688), when score notices render, then two documents exist, A's contains no B score and vice versa, each carries the §609(g) notice text, up to four key factors (five with inquiries), range, date, CRA contact and the H-3 elements (A)–(I); `FCRA_609G_SCORE_NOTICE_1BD` due Wed Oct 21 EOD is satisfied by the 15:00 Oct 20 delivery; `REGV_1022_74D_SCORE_NOTICE_CONSUMMATION_GATE` opens at 15:00.", async () => {
  const h = harness(EDT("2026-10-19", "18:40"), COLUMBUS_CREDITOR); h.received("APP-T6", EDT("2026-10-19", "18:40"), { transaction_type: "purchase", property_state: "OH", borrowers: [BORROWER_A_OH, BORROWER_B_OH] });
  const at = EDT("2026-10-20", "09:05"); h.clock.set(at);
  const A = h.svc.ingestCreditReport(report("APP-T6", "B-A", "Borrower A", "CR-A", at, 712, 4, false));
  const B = h.svc.ingestCreditReport(report("APP-T6", "B-B", "Borrower B", "CR-B", at, 688, 5, true));
  assert.equal(A.event.type, "credit.report.received"); assert.equal(A.event.payload.application_borrower_id, "B-A"); assert.equal(h.svc.scoreDisclosures("APP-T6").length, 2);
  assert.notEqual(A.disclosure!.rendered_document_id, B.disclosure!.rendered_document_id); assert.equal(A.disclosure!.retention_class, "regb_25m");
  const pa = h.svc.renderScoreDisclosure("APP-T6", "B-A", LENDER); const pb = h.svc.renderScoreDisclosure("APP-T6", "B-B", LENDER);
  assert.equal(pa.score_used, 712); assert.equal(pb.score_used, 688); assert.equal(pa.application_borrower_id, "B-A"); assert.equal(pb.application_borrower_id, "B-B");
  assert.deepEqual((pa.scores as { score: number }[]).map((s) => s.score), [712]); assert.deepEqual((pb.scores as { score: number }[]).map((s) => s.score), [688]);
  assert.ok(!JSON.stringify(pa).includes("Borrower B") && !JSON.stringify(pa).includes("B-B")); assert.ok(!JSON.stringify(pb).includes("Borrower A") && !JSON.stringify(pb).includes("B-A"));
  for (const p of [pa, pb]) {
    assert.equal(p.notice_text, FCRA_609G_NOTICE_TEXT); assert.match(p.notice_text as string, /^NOTICE TO THE HOME LOAN APPLICANT/);
    for (const k of ["A", "B", "C", "D", "E", "F", "G", "H", "I"] as const) assert.equal(p[`h3_${k.toLowerCase()}`], H3_ELEMENTS[k], `H-3 element (${k})`);
    const s = (p.scores as { range: string; date: string; cra_contact: string; key_factors: string[]; key_factor_count: number; representative: boolean }[])[0]!;
    assert.equal(s.range, "300-850"); assert.equal(s.date, "2026-10-20"); assert.equal(s.cra_contact, "CRA 2, Address 2, 555-0102"); assert.equal(s.representative, true); assert.ok(s.key_factors.length <= 5);
    assert.equal(p.distribution_bar_count, 5); assert.equal(p.lender_nmlsr_id, LENDER.nmlsr_id);
  }
  assert.equal((pa.scores as { key_factor_count: number }[])[0]!.key_factor_count, 4); assert.equal((pb.scores as { key_factor_count: number; inquiries_factor: boolean }[])[0]!.key_factor_count, 5); assert.equal((pb.scores as { inquiries_factor: boolean }[])[0]!.inquiries_factor, true);
  assert.equal(MAX_KEY_FACTORS, 4); assert.throws(() => scoreDisclosureFor(report("APP-T6", "B-A", "Borrower A", "CR-X", at, 712, 5, false)), (e: unknown) => e instanceof RangeError && /maximum of 4/.test(e.message));
  assert.throws(() => scoreDisclosureFor(report("APP-T6", "B-B", "Borrower B", "CR-Y", at, 688, 6, true)), (e: unknown) => e instanceof RangeError && /maximum of 5/.test(e.message));
  assert.throws(() => h.svc.renderScoreDisclosure("APP-T6", "B-C", LENDER), RangeError);
  // one row per borrower with the §609(g) clock: +1 business_days_creditor from the report → Wed Oct 21 EOD; the H-3 row rides with it under the consummation gate
  const rowA = A.rows[0]!; assert.equal(rowA.kind, "credit_score_notice"); assert.equal(rowA.application_borrower_id, "B-A"); assert.equal(rowA.due_at, EDT("2026-10-21", "23:59")); assert.equal(rowA.timer_code, "FCRA_609G_SCORE_NOTICE_1BD"); assert.equal(rowA.status, "generated");
  assert.equal(A.rows[1]!.kind, "rbp_notice"); assert.equal(A.rows[1]!.timer_code, SCORE_GATE); assert.equal(A.rows[1]!.notice_code, "NTC_REGV_1022_74_RBP_EXCEPTION");
  const fcra = h.timers.byCode("FCRA_609G_SCORE_NOTICE_1BD").filter((t) => t.applicationId === "APP-T6"); assert.equal(fcra.length, 2);
  for (const t of fcra) { assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-20"); assert.equal(t.dueDate, "2026-10-21"); }
  const gates = h.timers.byCode(SCORE_GATE).filter((t) => t.applicationId === "APP-T6"); assert.equal(gates.length, 2); assert.equal(gates[0]!.note, "evaluator:21.3.scoreNoticeGate"); assert.equal(gates[0]!.status, "armed");
  assert.equal(h.svc.evaluateGate("APP-T6", SCORE_GATE).open, false);
  // delivered Tue Oct 20 15:00 (inside the 1-BD policy): A first — the gate stays closed until B is covered
  h.clock.set(EDT("2026-10-20", "15:00"));
  const dA = h.svc.deliver("APP-T6", { kind: "credit_score_notice", application_borrower_id: "B-A", channel: "esign_portal", consent: CONSENT_B });
  assert.equal(dA.status, "delivered"); assert.equal(h.emitted("score_disclosure.delivered")[0]!.payload.all_borrowers_covered, false); assert.equal(h.emitted("score_disclosure.delivered")[0]!.payload.application_borrower_id, "B-A");
  assert.equal(fcra[0]!.status, "armed"); assert.equal(h.svc.evaluateGate("APP-T6", SCORE_GATE).open, false); assert.deepEqual(h.svc.scoreGateFacts("APP-T6"), { scored_borrowers: ["B-A", "B-B"], covered_borrowers: ["B-A"] });
  const dB = h.svc.deliver("APP-T6", { kind: "credit_score_notice", application_borrower_id: "B-B", channel: "esign_portal", consent: CONSENT_B });
  assert.equal(dB.status, "delivered"); assert.equal(h.emitted("score_disclosure.delivered")[1]!.payload.all_borrowers_covered, true);
  for (const t of [...fcra, ...gates]) { assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedAt, EDT("2026-10-20", "15:00")); }
  assert.equal(h.svc.evaluateGate("APP-T6", SCORE_GATE).open, true); assert.equal(evaluateGate("21.3.scoreNoticeGate", { ...h.svc.gateFacts("APP-T6", SCORE_GATE) }).open, true);
  assert.equal(h.svc.scoreDisclosures("APP-T6").find((d) => d.application_borrower_id === "B-A")!.delivered_at, EDT("2026-10-20", "15:00"));
  const rbp = h.svc.find("APP-T6", { kind: "rbp_notice", application_borrower_id: "B-A" })!; assert.equal(rbp.status, "delivered"); assert.equal(rbp.rendered_document_id, dA.rendered_document_id);
  // the bus tool refuses a cross-borrower notice and renders the same single-consumer payload
  const tools = bindTools(h, "APP-T6");
  await assert.rejects(tools.run("renderScoreDisclosure", { application_id: "APP-T6", application_borrower_id: "B-A", lender: LENDER, include_borrower_ids: ["B-A", "B-B"] }), (e: unknown) => e instanceof CommandRefused && e.code === "CROSS_BORROWER_SCORE");
  const via = (await tools.run("renderScoreDisclosure", { application_id: "APP-T6", application_borrower_id: "B-B", lender: LENDER })).output as Record<string, unknown>; assert.equal(via.score_used, 688); assert.deepEqual(via, pb);
  // no score → exempt{no_score}, no notice, no clock
  const none = h.svc.ingestCreditReport({ application_id: "APP-T6", application_borrower_id: "B-C", borrower_name: "Borrower C", credit_report_id: "CR-C", received_at: at, scores: [] });
  assert.equal(none.disclosure, null); assert.equal(none.rows[0]!.status, "exempt"); assert.equal(none.rows[0]!.exemption_reason, "no_score"); assert.equal(h.svc.evaluateGate("APP-T6", SCORE_GATE).open, true);
  assert.ok(registry().activeVersion("NTC_FCRA_609G_CREDIT_SCORE", D("2026-10-20")) && registry().activeVersion("NTC_REGV_1022_74_RBP_EXCEPTION", D("2026-10-20")), "score notice templates authored");
});
test("21.3-T7: Given B's score notice was never delivered, when 26.x calls `assertGateOpen(REGV_1022_74D_SCORE_NOTICE_CONSUMMATION_GATE)` on Wed Nov 18, 2026, then consummation is refused and a sev-1 escalation exists; delivery at 09:00 Nov 18 opens the gate.", () => {
  const h = harness(EDT("2026-10-19", "18:40"), COLUMBUS_CREDITOR); h.received("APP-T7", EDT("2026-10-19", "18:40"), { transaction_type: "purchase", property_state: "OH", borrowers: [BORROWER_A_OH, BORROWER_B_OH] });
  const at = EDT("2026-10-20", "09:05"); h.clock.set(at);
  h.svc.ingestCreditReport(report("APP-T7", "B-A", "Borrower A", "CR-A", at, 712, 4, false)); h.svc.ingestCreditReport(report("APP-T7", "B-B", "Borrower B", "CR-B", at, 688, 4, false));
  h.clock.set(EDT("2026-10-20", "15:00")); h.svc.deliver("APP-T7", { kind: "credit_score_notice", application_borrower_id: "B-A", channel: "esign_portal", consent: CONSENT_B });
  h.clock.set(EDT("2026-11-18", "08:00"));
  assert.throws(() => h.svc.assertGateOpen("APP-T7", SCORE_GATE, "consummate"), (e: unknown) => e instanceof CompanionGateClosed && e.code === SCORE_GATE && /B-B/.test(e.reason) && /1022\.74\(d\)\(3\)/.test(e.reason));
  const sev1 = h.escalations.list().filter((e) => e.kind === "sev1"); assert.equal(sev1.length, 1); assert.equal(sev1[0]!.severity, "1"); assert.equal(sev1[0]!.applicationId, "APP-T7"); assert.equal(sev1[0]!.ownerRole, "compliance"); assert.equal(sev1[0]!.payload.code, SCORE_GATE); assert.equal(sev1[0]!.payload.command, "consummate");
  const refused = h.emitted("gate.refused"); assert.equal(refused.length, 1); assert.equal(refused[0]!.payload.severity, 1); assert.equal(refused[0]!.payload.code, SCORE_GATE);
  assert.throws(() => assertGate("21.3.scoreNoticeGate", { ...h.svc.gateFacts("APP-T7", SCORE_GATE) }), (e: unknown) => e instanceof GateClosed && e.ref === "21.3.scoreNoticeGate");
  assert.deepEqual(h.svc.scoreGateFacts("APP-T7"), { scored_borrowers: ["B-A", "B-B"], covered_borrowers: ["B-A"] });
  const gates = h.timers.byCode(SCORE_GATE).filter((t) => t.applicationId === "APP-T7"); assert.equal(gates.length, 2); assert.ok(gates.every((t) => t.status === "armed"));
  assert.equal(h.timers.byCode("FCRA_609G_SCORE_NOTICE_1BD").filter((t) => t.applicationId === "APP-T7" && t.status === "armed").length, 2);   // B's §609(g) clock breached on Oct 21 in the real run; the gate is the consummation backstop
  // delivery at 09:00 Nov 18 (mailed with vendor proof) opens the gate
  h.clock.set(EDT("2026-11-18", "09:00")); const dB = h.svc.deliver("APP-T7", { kind: "credit_score_notice", application_borrower_id: "B-B", channel: "mail", mailing_proof_id: "PMV-2026-11-18-0001" });
  assert.equal(dB.status, "mailed"); assert.equal(h.emitted("score_disclosure.delivered")[1]!.payload.all_borrowers_covered, true);
  h.svc.assertGateOpen("APP-T7", SCORE_GATE, "consummate"); assert.equal(h.escalations.list().filter((e) => e.kind === "sev1").length, 1); assert.equal(h.emitted("gate.refused").length, 1);
  for (const t of gates) { assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedAt, EDT("2026-11-18", "09:00")); }
  assert.equal(evaluateGate("21.3.scoreNoticeGate", { ...h.svc.gateFacts("APP-T7", SCORE_GATE) }).open, true);
  assert.equal(scoreNoticeGate({ scored_borrowers: ["B-A", "B-B"], covered_borrowers: ["B-B", "B-A"] }).open, true); assert.match(scoreNoticeGate({ scored_borrowers: ["B-A"], covered_borrowers: [] }).reason!, /B-A/);
});
test("21.3-T8: Given `application.arm_interest.recorded{4928, electronic}` at Mon Oct 19 19:05 EDT and no delivery, when the app attempts to render the ARM 1003 section or 21.4 attempts `impose_fee`, then both are refused by `REGZ_1026_19B_ARM_DISCLOSURE_GATE`; after CHARM (2020-06) and the Plan 4928 program disclosure are viewed at 19:06, both succeed; the program disclosure shows index \"30-day Average SOFR\", a 45-day lookback, caps 5/1/5, rounding to the nearest one-eighth, the $10,000 illustration and the twelve content items.", async () => {
  const h = harness(EDT("2026-10-19", "18:40"), COLUMBUS_CREDITOR); h.received("APP-T8", EDT("2026-10-19", "18:40"), { transaction_type: "purchase", property_state: "OH", borrowers: [BORROWER_A_OH, BORROWER_B_OH] });
  const fixed = h.svc.find("APP-T8", { kind: "arm_program" })!; assert.equal(fixed.status, "exempt"); assert.equal(fixed.exemption_reason, "fixed_rate");
  assert.equal(h.svc.checkCommandGates("APP-T8", "impose_fee", { fee_kind: "credit_report" }).gates.find((g) => g.code === ARM_GATE)!.result, "not_applicable");
  const arm = h.armInterest("APP-T8", EDT("2026-10-19", "19:05"), "4928", "electronic");
  assert.equal(arm.program.status, "planned"); assert.equal(arm.program.notice_code, "NTC_REGZ_1026_19B_ARM_PROGRAM"); assert.equal(arm.program.timer_code, ARM_GATE); assert.equal(arm.program.due_at, null); assert.equal(arm.program.references.fnma_plan_number, "4928"); assert.equal(arm.program.references.channel, "electronic");
  assert.equal(arm.charm.notice_code, "NTC_REGZ_1026_19B_CHARM"); assert.equal(arm.charm.asset_version, "2020-06"); assert.equal(arm.charm.asset_version, CHARM_EDITION); assert.equal(fixed.status, "superseded"); assert.equal(fixed.superseded_by_id, arm.program.disclosure_id); assert.equal(h.svc.get(fixed.disclosure_id), arm.program);
  const gate = h.timer(ARM_GATE, "APP-T8"); assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:21.3.armDisclosureGate"); assert.equal(gate.anchorDate, "2026-10-19");
  assert.equal(h.timers.byCode(TIMER_CODES.arm_3bd).filter((t) => t.applicationId === "APP-T8").length, 0);   // electronic channel: no 3-BD outer bound
  h.clock.set(EDT("2026-10-19", "19:05"));
  assert.throws(() => h.svc.checkCommandGates("APP-T8", "render_arm_1003_section"), (e: unknown) => e instanceof CompanionGateClosed && e.code === ARM_GATE && /NTC_REGZ_1026_19B_CHARM and NTC_REGZ_1026_19B_ARM_PROGRAM\{4928\}/.test(e.reason));
  assert.throws(() => h.svc.checkCommandGates("APP-T8", "impose_fee", { fee_kind: "credit_report", amount_cents: 7_500n }), (e: unknown) => e instanceof CompanionGateClosed && e.code === ARM_GATE);
  const checks = h.svc.feeGateChecks("APP-T8"); assert.equal(checks.length, 3); assert.equal(checks[1]!.command, "render_arm_1003_section"); assert.equal(checks[2]!.command, "impose_fee"); assert.equal(checks[2]!.result, "closed"); assert.equal(checks[2]!.gates.find((g) => g.code === ARM_GATE)!.result, "closed");
  assert.equal(h.emitted("gate.refused").length, 2); assert.throws(() => assertGate("21.3.armDisclosureGate", { ...h.svc.gateFacts("APP-T8", ARM_GATE) }), GateClosed);
  // viewed at 19:06 in the app (electronic under consent on/with the application — §1026.19(c)); the authenticated view is receipt evidence
  h.clock.set(EDT("2026-10-19", "19:06"));
  const charm = h.svc.deliver("APP-T8", { kind: "charm", channel: "esign_portal", consent: CONSENT_B, asset_version: "2020-06" }); assert.equal(charm.status, "delivered");
  assert.equal(h.svc.evaluateGate("APP-T8", ARM_GATE).open, false); assert.equal(h.emitted("arm.disclosures.delivered").length, 0); assert.equal(gate.status, "armed");
  assert.throws(() => h.svc.deliver("APP-T8", { kind: "charm", channel: "esign_portal", consent: CONSENT_B, asset_version: "2014-01" }), (e: unknown) => e instanceof CompanionRefused && e.code === "ALREADY_TERMINAL");
  const prog = h.svc.deliver("APP-T8", { kind: "arm_program", channel: "esign_portal", consent: CONSENT_B }); assert.equal(prog.status, "delivered"); assert.equal(prog.asset_version, arm.disclosure.template_version);
  const opened = h.emitted("arm.disclosures.delivered")[0]!; assert.equal(opened.payload.fnma_plan_number, "4928"); assert.equal(opened.payload.gate_opened_at, EDT("2026-10-19", "19:06")); assert.equal(opened.payload.charm_edition, "2020-06");
  assert.equal(gate.status, "satisfied"); assert.equal(gate.satisfiedAt, EDT("2026-10-19", "19:06")); assert.equal(h.svc.evaluateGate("APP-T8", ARM_GATE).open, true);
  h.svc.recordReceipt("APP-T8", { kind: "charm", at: EDT("2026-10-19", "19:06"), borrower_id: "B-B", evidence: "authenticated_view" }); assert.equal(h.svc.find("APP-T8", { kind: "charm" })!.status, "received");
  assert.equal(h.svc.checkCommandGates("APP-T8", "render_arm_1003_section").result, "open"); assert.equal(h.svc.checkCommandGates("APP-T8", "impose_fee", { fee_kind: "credit_report" }).result, "open"); assert.equal(h.svc.checkCommandGates("APP-T8", "issueLE").result, "open");
  assert.equal(h.emitted("gate.refused").length, 2); assert.equal(evaluateGate("21.3.armDisclosureGate", { ...h.svc.gateFacts("APP-T8", ARM_GATE) }).open, true);
  // the Plan 4928 program disclosure (§1026.19(b)(2)(i)–(xii))
  const d = arm.disclosure; assert.equal(d.fnma_plan_number, "4928"); assert.equal(d.label, "7/6 SOFR"); assert.match(d.index, /^30-day Average SOFR/); assert.equal(d.lookback_days, 45); assert.deepEqual(d.caps, { first: "5", subsequent: "1", lifetime: "5" }); assert.match(d.rounding, /nearest one-eighth/);
  assert.equal(d.illustration.loan_cents, 1_000_000n); assert.equal(d.illustration.as_of, "2026-10"); assert.equal(d.illustration.initial_rate_pct, "5.875"); assert.equal(d.illustration.max_rate_pct, "10.875"); assert.equal(d.illustration.months_to_max_rate, 84);   // 7/6: fixed 84 months, then the 5-point first cap reaches the lifetime cap at once
  assert.equal(d.content_items.length, 12); assert.deepEqual(d.content_items.map((c) => c.item), ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"]); assert.equal(d.consumer_specific_rate, null);
  assert.match(d.content_items[1]!.text, /30-day Average SOFR/); assert.match(d.content_items[2]!.text, /45 days before the interest change date/); assert.match(d.content_items[6]!.text, /first change is limited to 5 percentage points, each later change to 1 percentage point\(s\), and the rate can never be more than 5 percentage points above/);
  assert.match(d.content_items[7]!.text, /\$10,000 loan/); assert.match(d.content_items[7]!.text, /may increase or decrease substantially/); assert.match(d.content_items[9]!.text, /does not contain a demand feature/); assert.match(d.content_items[10]!.text, /210 to 240 days/);
  assert.throws(() => armPlan("4930"), RangeError); assert.equal(arm.program.data_snapshot_id, "ARM-ILL-4928-2026-10");
  // the bus tool: program-level only — a consumer-specific rate is refused
  const tools = bindTools(h, "APP-T8");
  await assert.rejects(tools.run("renderArmProgramDisclosure", { fnma_plan_number: "4928", consumer_rate_pct: "6.250" }), (e: unknown) => e instanceof CommandRefused && e.code === "CONSUMER_SPECIFIC_RATE");
  const viaBus = (await tools.run("renderArmProgramDisclosure", { fnma_plan_number: "4928", initial_rate_pct: "5.875", illustration_as_of: "2026-10" })).output as ArmProgramDisclosure; assert.deepEqual(viaBus, d);
  // NTC_REGZ_1026_19B_ARM_PROGRAM in the registry: the process's disclosure passes the template's (i)–(xii) checklist
  const v = registry().activeVersion("NTC_REGZ_1026_19B_ARM_PROGRAM", D("2026-10-19")); assert.ok(v, "NTC_REGZ_1026_19B_ARM_PROGRAM authored"); const tpl = armTemplatePayload(d);
  const check = evaluateChecklist(v!, tpl, render(v!.source, tpl)); assert.deepEqual(check.blocking.map((b) => b.rule_id), []); assert.equal(check.passed, true);
  assert.ok(registry().activeVersion("NTC_REGZ_1026_19B_CHARM", D("2026-10-19")), "NTC_REGZ_1026_19B_CHARM authored");
});
test("21.3-T9: Given the same interest expressed by telephone on Mon Oct 19 with no E-SIGN consent, when the documents are mailed Tue Oct 20 with vendor proof, then `REGZ_1026_19B_ARM_DISCLOSURE_3BD` (due Thu Oct 22) is satisfied and the gate opens on the mailing proof; mailing on Fri Oct 23 breaches (sev 1).", () => {
  const h = harness(EDT("2026-10-19", "18:40"), COLUMBUS_CREDITOR); h.received("APP-T9", EDT("2026-10-19", "18:40"), { transaction_type: "purchase", property_state: "OH", borrowers: [BORROWER_A_OH, BORROWER_B_OH] });
  const arm = h.armInterest("APP-T9", EDT("2026-10-19", "19:05"), "4928", "telephone");
  assert.equal(arm.program.references.channel, "telephone"); assert.equal(arm.program.due_at, EDT("2026-10-22", "23:59")); assert.equal(arm.charm.due_at, EDT("2026-10-22", "23:59"));   // the outer bound: +3 business_days_creditor
  const t = h.timer(TIMER_CODES.arm_3bd, "APP-T9"); assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-19"); assert.equal(t.dueDate, "2026-10-22");
  const gate = h.timer(ARM_GATE, "APP-T9"); assert.equal(gate.status, "armed");
  h.clock.set(EDT("2026-10-19", "19:10"));
  assert.throws(() => h.svc.deliver("APP-T9", { kind: "charm", channel: "esign_portal", consent: null }), (e: unknown) => e instanceof CompanionRefused && e.code === "NO_ESIGN_CONSENT");
  assert.throws(() => h.svc.deliver("APP-T9", { kind: "charm", channel: "email", consent: { ...CONSENT_B, revoked_at: EDT("2026-10-19", "19:00") } }), (e: unknown) => e instanceof CompanionRefused && e.code === "NO_ESIGN_CONSENT");
  assert.throws(() => h.svc.deliver("APP-T9", { kind: "charm", channel: "mail" }), (e: unknown) => e instanceof CompanionRefused && e.code === "NO_MAILING_PROOF");
  assert.equal(h.emitted("disclosure.companion.delivery.refused").length, 3); assert.throws(() => h.svc.checkCommandGates("APP-T9", "issueLE"), CompanionGateClosed);
  // mailed Tue Oct 20 (next creditor business day; the Oct 19 evening is after the print cut-off) with the vendor's proof
  h.clock.set(EDT("2026-10-20", "10:00"));
  const c = h.svc.deliver("APP-T9", { kind: "charm", channel: "mail", mailing_proof_id: "PMV-2026-10-20-0001" }); assert.equal(c.status, "mailed"); assert.equal(c.mailing_proof_id, "PMV-2026-10-20-0001"); assert.equal(c.mailed_at, EDT("2026-10-20", "10:00"));
  assert.equal(t.status, "armed"); assert.equal(gate.status, "armed");   // both documents must be in the mail
  const p = h.svc.deliver("APP-T9", { kind: "arm_program", channel: "mail", mailing_proof_id: "PMV-2026-10-20-0001" }); assert.equal(p.status, "mailed");
  const opened = h.emitted("arm.disclosures.delivered")[0]!; assert.equal(opened.payload.via, "mailed"); assert.equal(opened.payload.fnma_plan_number, "4928"); assert.equal(opened.payload.gate_opened_at, EDT("2026-10-20", "10:00"));
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedAt, EDT("2026-10-20", "10:00")); assert.equal(gate.status, "satisfied"); assert.equal(h.svc.evaluateGate("APP-T9", ARM_GATE).open, true);
  assert.deepEqual(h.svc.armGateFacts("APP-T9"), { arm_interest_recorded: true, charm_out_at: EDT("2026-10-20", "10:00"), program_out_at: EDT("2026-10-20", "10:00"), fnma_plan_number: "4928" });
  assert.equal(h.emitted("disclosure.companion.mailed").length, 2); assert.equal(h.svc.checkCommandGates("APP-T9", "issueLE").result, "open");   // the Oct 22 LE is unaffected
  // mailing on Fri Oct 23: the clock breached at the Oct 22 end of day (sev 1 → compliance-sentinel + officer, incident); the gate stays closed to fees and the ARM LE until the proof exists
  const g = harness(EDT("2026-10-19", "18:40"), COLUMBUS_CREDITOR); g.received("APP-T9b", EDT("2026-10-19", "18:40"), { transaction_type: "purchase", property_state: "OH", borrowers: [BORROWER_A_OH, BORROWER_B_OH] });
  g.armInterest("APP-T9b", EDT("2026-10-19", "19:05"), "4928", "telephone");
  g.clock.set(EDT("2026-10-23", "09:00")); const breaches = g.timers.evaluate(g.clock.now()); const b0 = breaches.find((b) => b.instance.code === TIMER_CODES.arm_3bd)!; assert.equal(b0.severity, 1);
  const tb = g.timer(TIMER_CODES.arm_3bd, "APP-T9b"); assert.equal(tb.status, "breached"); assert.equal(tb.breachedAt, EDT("2026-10-23", "09:00"));
  const b = g.svc.onTimerBreached("APP-T9b", TIMER_CODES.arm_3bd, g.clock.now()); assert.equal(b.severity, 1); assert.deepEqual([...b.escalated_to], ["compliance-sentinel", "officer"]); assert.equal(b.incident_id, "INC-REGZ_1026_19B_ARM_DISCLOSURE_3BD-APP-T9b");
  const sev1 = g.escalations.list().find((e) => e.kind === "sev1")!; assert.equal(sev1.severity, "1"); assert.equal(sev1.ownerRole, "officer"); assert.equal(sev1.payload.code, TIMER_CODES.arm_3bd); assert.equal(g.emitted("compliance.incident.opened")[0]!.payload.incident_id, b.incident_id);
  assert.throws(() => g.svc.checkCommandGates("APP-T9b", "impose_fee", { fee_kind: "appraisal" }), (e: unknown) => e instanceof CompanionGateClosed && e.code === ARM_GATE);
  g.svc.deliver("APP-T9b", { kind: "charm", channel: "mail", mailing_proof_id: "PMV-2026-10-23-0001" }); g.svc.deliver("APP-T9b", { kind: "arm_program", channel: "mail", mailing_proof_id: "PMV-2026-10-23-0001" });
  assert.equal(tb.status, "satisfied_late"); assert.equal(g.timer(ARM_GATE, "APP-T9b").status, "satisfied"); assert.equal(g.svc.checkCommandGates("APP-T9b", "impose_fee", { fee_kind: "appraisal" }).result, "open");
});
test("21.3-T10: Given `affiliate_relationships` holds the partner's 30 % interest in \"Acme Title\" and 24.4 requests a referral to Acme on Tue Oct 6, then `REGX_1024_15_AFBA_REFERRAL_GATE` refuses until `NTC_REGX_1024_15_AFBA` (Appendix D format, separate document, charge range) is delivered ≤ the referral time; the provider list marks Acme `affiliate=true`; a `required_use=true` flag for Acme title is rejected (not an attorney/CRA/appraiser).", async () => {
  const REL: AffiliateRelationship = { id: "AR-1", owner_party_id: "partner", provider_party_id: "P-ACME", provider_name: "Acme Title", relationship: "ownership_gt_1pct", ownership_pct: "30.00", services: ["title_lenders_policy", "title_settlement"], charge_range: { title_settlement: { low_cents: 40_000n, high_cents: 60_000n }, title_lenders_policy: { low_cents: 90_000n, high_cents: 130_000n } }, effective_from: D("2026-01-01"), effective_to: null };
  const GATE: CompanionGateCode = "REGX_1024_15_AFBA_REFERRAL_GATE";
  const h = harness(MST("2026-10-05", "10:16"), PHOENIX_CREDITOR, { rels: [REL] }); h.received("APP-T10", MST("2026-10-05", "10:16"), { transaction_type: "limited_cash_out", property_state: "AZ" });
  const exempt = h.svc.find("APP-T10", { kind: "afba" })!; assert.equal(exempt.status, "exempt"); assert.equal(exempt.exemption_reason, "no_affiliate_referral"); assert.equal(exempt.references.inventory, 1);
  assert.equal(afbaRelationship([REL], ["partner", "sm"], "P-ACME", D("2026-10-06"))!.ownership_pct, "30.00"); assert.equal(afbaRelationship([REL], ["partner"], "P-OTHER", D("2026-10-06")), null);
  assert.equal(afbaRelationship([{ ...REL, ownership_pct: "1.00" }], ["partner"], "P-ACME", D("2026-10-06")), null);   // more than 1 % only (§2602(7)(A))
  assert.equal(afbaRelationship([REL], ["partner"], "P-ACME", D("2025-12-31")), null);   // before the effective date
  // an unaffiliated referral (the AMC on Oct 6) needs no statement: afba_required=false, recorded at once
  h.clock.set(MST("2026-10-06", "09:30")); const amc = h.svc.requestReferral("APP-T10", { referring_party_id: "partner", provider_party_id: "P-AMC", provider_name: "AMC 1", service: "appraisal", at: MST("2026-10-06", "09:30"), source_process: "24.1" });
  assert.equal(amc.referral.afba_required, false); assert.equal(amc.gate.open, true); assert.equal(amc.referral.recorded, true); assert.equal(h.emitted("referral.recorded")[0]!.payload.afba_gate, "not_required"); assert.equal(h.timers.byCode(GATE).filter((t) => t.applicationId === "APP-T10").length, 0);
  // 24.4 refers to Acme Tue Oct 6 10:00: the gate refuses until the Appendix D statement is out no later than the referral
  h.clock.set(MST("2026-10-06", "10:00"));
  const r1 = h.svc.requestReferral("APP-T10", { referring_party_id: "partner", provider_party_id: "P-ACME", provider_name: "Acme Title", service: "title_settlement", at: MST("2026-10-06", "10:00"), source_process: "24.4" });
  assert.equal(r1.referral.afba_required, true); assert.equal(r1.gate.open, false); assert.equal(r1.referral.recorded, false); assert.match(r1.gate.reason!, /1024\.15\(b\)\(1\)/);
  assert.equal(r1.afba_row!.status, "planned"); assert.equal(r1.afba_row!.notice_code, "NTC_REGX_1024_15_AFBA"); assert.equal(r1.afba_row!.retention_class, "respa_afba_5y"); assert.equal(r1.afba_row!.references.separate_document, true); assert.equal(r1.afba_row!.references.ownership_pct, "30.00"); assert.equal(r1.referral.afba_disclosure_id, r1.afba_row!.disclosure_id);
  const gate = h.timer(GATE, "APP-T10"); assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:21.3.afbaReferralGate"); assert.equal(h.emitted("referral.requested")[1]!.payload.afba_required, true);
  assert.equal(h.emitted("referral.recorded").length, 1); const sev2 = h.escalations.list().filter((e) => e.kind === "sev2"); assert.equal(sev2.length, 1); assert.equal(sev2[0]!.payload.code, GATE); assert.equal(sev2[0]!.payload.referral_id, r1.referral.referral_id);
  assert.throws(() => h.svc.assertGateOpen("APP-T10", GATE, "order_title"), (e: unknown) => e instanceof CompanionGateClosed && e.code === GATE);
  assert.throws(() => assertGate("21.3.afbaReferralGate", { ...h.svc.gateFacts("APP-T10", GATE) }), GateClosed);
  // the statement (Appendix D format): nature of the relationship, the charge range for the service, a separate document
  const stmt = afbaStatementPayload(REL, { referring_party_name: "Partner 1", applicant_name: "Borrower A", service: "title_settlement", on: D("2026-10-06"), lender_name: LENDER.name });
  assert.equal(stmt.charge_low_cents, 40_000n); assert.equal(stmt.charge_high_cents, 60_000n); assert.match(stmt.nature_of_relationship as string, /30\.00% ownership interest in Acme Title/); assert.equal(stmt.required_use, false); assert.equal(stmt.relationship, "ownership_gt_1pct");
  assert.throws(() => h.svc.deliver("APP-T10", { disclosure_id: r1.afba_row!.disclosure_id, channel: "esign_portal", consent: CONSENT, with_le_disclosure_id: "LE-1" }), (e: unknown) => e instanceof CompanionRefused && e.code === "AFBA_SEPARATE_DOCUMENT");
  h.clock.set(MST("2026-10-06", "10:20")); const d = h.svc.deliver("APP-T10", { disclosure_id: r1.afba_row!.disclosure_id, channel: "esign_portal", consent: CONSENT });
  assert.equal(d.status, "delivered"); const dev = h.emitted("afba.disclosure.delivered")[0]!; assert.equal(dev.payload.referral_id, r1.referral.referral_id); assert.equal(dev.payload.separate_document, true); assert.equal(dev.payload.provider_party_id, "P-ACME");
  // the 10:00 referral predates the 10:20 statement — still closed for it; a referral at/after the statement opens the gate and is recorded
  assert.equal(afbaReferralGate({ afba_required: true, disclosure_out_at: MST("2026-10-06", "10:20"), referred_at: MST("2026-10-06", "10:00") }).open, false);
  assert.equal(afbaReferralGate({ afba_required: true, disclosure_out_at: MST("2026-10-06", "10:20"), referred_at: MST("2026-10-06", "10:20") }).open, true);
  const r2 = h.svc.requestReferral("APP-T10", { referring_party_id: "partner", provider_party_id: "P-ACME", provider_name: "Acme Title", service: "title_settlement", at: MST("2026-10-06", "10:25"), source_process: "24.4" });
  assert.equal(r2.gate.open, true); assert.equal(r2.referral.recorded, true); assert.equal(r2.referral.afba_disclosure_id, r1.afba_row!.disclosure_id); assert.equal(r2.afba_row!.disclosure_id, r1.afba_row!.disclosure_id);
  const rec = h.emitted("referral.recorded")[1]!; assert.equal(rec.payload.afba_gate, "open"); assert.equal(rec.payload.referral_id, r2.referral.referral_id); assert.equal(gate.status, "satisfied"); assert.equal(h.svc.evaluateGate("APP-T10", GATE).open, true);
  h.svc.assertGateOpen("APP-T10", GATE, "order_title"); assert.equal(h.svc.referrals("APP-T10").length, 3);
  // the provider list (21.2) marks Acme affiliate=true so the tolerance engine treats its charges as zero-tolerance
  const providers = h.svc.affiliatesMarked([{ party_id: "P-ACME", name: "Acme Title", affiliate: false, estimated_fee_cents: 49_500n }, { party_id: "P-GCT", name: "Title 2", affiliate: false, estimated_fee_cents: 49_500n }], D("2026-10-06"));
  assert.deepEqual(providers.map((p) => [p.party_id, p.affiliate]), [["P-ACME", true], ["P-GCT", false]]);
  // required use only of an attorney, credit reporting agency or appraiser (§1024.15(b)(2)): a required-use flag for Acme title is rejected
  assert.throws(() => validateRequiredUse("title_settlement", true), (e: unknown) => e instanceof RangeError && /1024\.15\(b\)\(2\)/.test(e.message));
  assert.throws(() => h.svc.requestReferral("APP-T10", { referring_party_id: "partner", provider_party_id: "P-ACME", provider_name: "Acme Title", service: "title_settlement", at: MST("2026-10-06", "10:30"), source_process: "24.4", required_use: true }), RangeError);
  validateRequiredUse("appraiser", true); validateRequiredUse("attorney", true); validateRequiredUse("credit_reporting_agency", true); validateRequiredUse("title_settlement", false);
  assert.equal(afbaReferralGate({ afba_required: true, disclosure_out_at: MST("2026-10-05", "16:10"), referred_at: MST("2026-10-06", "10:00"), required_provider: true, application_received_at: MST("2026-10-05", "10:16") }).open, false);   // a required provider's statement is due at application
  assert.equal(afbaReferralGate({ afba_required: true, disclosure_out_at: MST("2026-10-05", "10:16"), referred_at: MST("2026-10-06", "10:00"), required_provider: true, application_received_at: MST("2026-10-05", "10:16") }).open, true);
  const tools = bindTools(h, "APP-T10");
  await assert.rejects(tools.run("evaluateAfBA", { application_id: "APP-T10", provider_party_id: "P-ACME", service: "title_settlement", required_use: true }), (e: unknown) => e instanceof CommandRefused && e.code === "REQUIRED_USE_OUTSIDE_1024_15B2");
  const pure = (await tools.run("evaluateAfBA", { provider_party_id: "P-ACME", service: "title_settlement", affiliate_relationships: [REL], on: "2026-10-06", referred_at: MST("2026-10-06", "10:25"), disclosure_out_at: MST("2026-10-06", "10:20"), providers: [{ party_id: "P-ACME", name: "Acme Title", affiliate: false, estimated_fee_cents: 49_500n }] })).output as { afba_required: boolean; gate: { open: boolean }; providers: { affiliate: boolean }[]; statement: { charge_high_cents: bigint } };
  assert.equal(pure.afba_required, true); assert.equal(pure.gate.open, true); assert.equal(pure.providers[0]!.affiliate, true); assert.equal(pure.statement.charge_high_cents, 60_000n);
  assert.ok(registry().activeVersion("NTC_REGX_1024_15_AFBA", D("2026-10-06")), "NTC_REGX_1024_15_AFBA authored");
});
test("21.3-T11: Given a NY property and a voice application started Tue Oct 20 10:00, when the borrower has not acknowledged `NTC_NY_3NYCRR_38_3_PREAPP_DISCLOSURE`, then `application.received` cannot fire and any `impose_fee` (incl. credit report) is refused; the confirm-button event at 10:07 opens the gate and the interview proceeds.", () => {
  const GATE: CompanionGateCode = "NY_3NYCRR_38_3_PREAPP_DISCLOSURE_GATE"; const CONSENT_NY: EsignConsent = { id: "CNS-ESIGN-3", scope: ["disclosures"], granted_at: EDT("2026-10-20", "10:01") };
  const h = harness(EDT("2026-10-20", "10:00"), COLUMBUS_CREDITOR);
  const s = h.started("APP-T11", EDT("2026-10-20", "10:00"), { property_state: "NY", intake_channel: "voice" });
  assert.equal(s.rows.length, 1); const ny = s.rows[0]!; assert.equal(ny.kind, "state:NY"); assert.equal(ny.rule_code, "NY_3NYCRR_38_3"); assert.equal(ny.notice_code, "NTC_NY_3NYCRR_38_3_PREAPP_DISCLOSURE"); assert.equal(ny.acknowledgment_required, true); assert.equal(ny.status, "planned"); assert.equal(ny.due_at, null); assert.equal(ny.anchor_event, "application.started");
  assert.deepEqual(ny.references.blocks, ["application.received", "impose_fee"]); assert.deepEqual(s.matrix.pre_application_gates.map((r) => r.timer_code), [GATE]); assert.equal(s.matrix.confidence, "partially_verified");
  const gate = h.timer(GATE, "APP-T11"); assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:21.3.nyPreappDisclosureGate");
  assert.equal(h.timer("NJ_3_1_16_3_FEE_DISCLOSURE_GATE", "APP-T11").status, "cancelled"); assert.equal(h.timer("FL_69B_124_013_ANTI_COERCION_AT_APPLICATION", "APP-T11").cancelledReason, "state_not_applicable");
  h.clock.set(EDT("2026-10-20", "10:03"));
  assert.throws(() => h.svc.checkCommandGates("APP-T11", "application.received"), (e: unknown) => e instanceof CompanionGateClosed && e.code === GATE && /cannot be taken and no fee may be imposed/.test(e.reason));
  assert.throws(() => h.svc.checkCommandGates("APP-T11", "impose_fee", { fee_kind: "credit_report", amount_cents: 7_500n }), (e: unknown) => e instanceof CompanionGateClosed && e.code === GATE);
  assert.throws(() => h.svc.checkCommandGates("APP-T11", "impose_fee", { fee_kind: "appraisal", amount_cents: 65_000n }), CompanionGateClosed);
  const checks = h.svc.feeGateChecks("APP-T11"); assert.equal(checks.length, 3); assert.equal(checks[1]!.fee_kind, "credit_report"); assert.equal(checks[1]!.gates.find((g) => g.code === GATE)!.result, "closed"); assert.equal(h.emitted("gate.refused").length, 3);
  assert.throws(() => assertGate("21.3.nyPreappDisclosureGate", { ...h.svc.gateFacts("APP-T11", GATE) }), GateClosed);
  // nothing to acknowledge before delivery; delivery alone does not open the gate
  assert.throws(() => h.svc.recordAcknowledgment("APP-T11", { kind: "state:NY", at: EDT("2026-10-20", "10:07"), borrower_id: "B-A", method: "confirm_button", evidence_id: "ACK-NY-1" }), (e: unknown) => e instanceof CompanionRefused && e.code === "NOT_ISSUED");
  assert.throws(() => h.svc.deliver("APP-T11", { kind: "state:NY", channel: "esign_portal", consent: null }), (e: unknown) => e instanceof CompanionRefused && e.code === "NO_ESIGN_CONSENT");   // voice-only without consent: mail for signature
  const d = h.svc.deliver("APP-T11", { kind: "state:NY", channel: "esign_portal", consent: CONSENT_NY }); assert.equal(d.status, "delivered"); const dev = h.emitted("state_notice.delivered")[0]!; assert.equal(dev.payload.code, "NY_3NYCRR_38_3"); assert.equal(dev.payload.state, "NY");
  assert.equal(gate.status, "armed"); assert.equal(h.svc.evaluateGate("APP-T11", GATE).open, false);
  // the confirm button at 10:07 opens the gate
  const ack = h.svc.recordAcknowledgment("APP-T11", { kind: "state:NY", at: EDT("2026-10-20", "10:07"), borrower_id: "B-A", method: "confirm_button", evidence_id: "ACK-NY-1" });
  assert.equal(ack.status, "acknowledged"); assert.equal(ack.acknowledged_at, EDT("2026-10-20", "10:07")); assert.equal(ack.acknowledgment_evidence_id, "ACK-NY-1");
  const aev = h.emitted("state_notice.acknowledged")[0]!; assert.equal(aev.payload.code, "NY_3NYCRR_38_3"); assert.equal(aev.payload.method, "confirm_button"); assert.equal(gate.status, "satisfied"); assert.equal(gate.satisfiedAt, EDT("2026-10-20", "10:07"));
  assert.equal(h.svc.evaluateGate("APP-T11", GATE).open, true); assert.equal(h.svc.checkCommandGates("APP-T11", "application.received", { at: EDT("2026-10-20", "10:08") }).result, "open");
  const p = h.received("APP-T11", EDT("2026-10-20", "10:08"), { transaction_type: "purchase", property_state: "NY" });
  assert.equal(p.rows.some((r) => r.rule_code === "NY_3NYCRR_38_3"), false); assert.equal(h.svc.find("APP-T11", { rule_code: "NY_3NYCRR_38_3" })!.status, "acknowledged");   // the pre-application row is the one row
  assert.equal(h.svc.checkCommandGates("APP-T11", "impose_fee", { fee_kind: "credit_report" }).result, "open"); assert.equal(h.emitted("gate.refused").length, 3);
  assert.equal(stateAcknowledgmentGate({ property_state: "OH", state: "NY", rule_code: "NY_3NYCRR_38_3", acknowledged_at: null }).open, true); assert.equal(evaluateGate("21.3.nyPreappDisclosureGate", { property_state: "NY", acknowledged_at: null }).open, false);
  assert.ok(registry().activeVersion("NTC_NY_3NYCRR_38_3_PREAPP_DISCLOSURE", D("2026-10-20")), "NTC_NY_3NYCRR_38_3_PREAPP_DISCLOSURE authored");
});
test("21.3-T12: Given an AZ property, when 21.4 attempts the $650 appraisal fee on Tue Oct 6 09:20 MST before the borrower has signed `NTC_AZ_ARS_6_946C_FEE_AGREEMENT`, then the fee is refused (`fee_gate_checks` records the AZ gate); after the e-signature (Oct 5 17:44 in the fixture) the fee is imposed.", async () => {
  const GATE: CompanionGateCode = "AZ_ARS_6_946C_FEE_AGREEMENT_GATE";
  const h = harness(MST("2026-10-05", "10:16")); const p = h.received("APP-T12", MST("2026-10-05", "10:16"), { transaction_type: "limited_cash_out", property_state: "AZ", property_zip5: "85018" });
  const az = p.rows.find((r) => r.rule_code === "AZ_ARS_6_946C")!; assert.equal(az.kind, "state:AZ"); assert.equal(az.notice_code, "NTC_AZ_ARS_6_946C_FEE_AGREEMENT"); assert.equal(az.acknowledgment_required, true); assert.equal(az.timer_code, GATE); assert.equal(az.status, "planned"); assert.deepEqual(az.references.blocks, ["impose_fee"]);
  const gate = h.timer(GATE, "APP-T12"); assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:21.3.azFeeAgreementGate");
  h.clock.set(MST("2026-10-06", "09:20"));
  assert.throws(() => h.svc.checkCommandGates("APP-T12", "impose_fee", { fee_kind: "appraisal", amount_cents: 65_000n }), (e: unknown) => e instanceof CompanionGateClosed && e.code === GATE && /A\.R\.S\.|AZ_ARS_6_946C/.test(e.reason));
  const chk = h.svc.feeGateChecks("APP-T12")[0]!; assert.equal(chk.command, "impose_fee"); assert.equal(chk.fee_kind, "appraisal"); assert.equal(chk.amount_cents, 65_000n); assert.equal(chk.checked_at, MST("2026-10-06", "09:20")); assert.equal(chk.result, "closed");
  assert.deepEqual(chk.gates.map((g) => [g.code, g.result]), [["REGZ_1026_19B_ARM_DISCLOSURE_GATE", "not_applicable"], ["NY_3NYCRR_38_3_PREAPP_DISCLOSURE_GATE", "not_applicable"], ["NJ_3_1_16_3_FEE_DISCLOSURE_GATE", "not_applicable"], [GATE, "closed"], ["FL_69B_124_013_ANTI_COERCION_AT_APPLICATION", "not_applicable"]]);
  const refused = h.emitted("gate.refused")[0]!; assert.equal(refused.payload.code, GATE); assert.equal(refused.payload.fee_kind, "appraisal"); assert.equal(refused.payload.check_id, chk.check_id);
  // the fixture: the fee agreement rides the 16:10 package and is e-signed Oct 5 17:44 → gate open
  h.svc.deliver("APP-T12", { kind: "state:AZ", channel: "esign_portal", consent: CONSENT, at: MST("2026-10-05", "16:10") }); assert.equal(gate.status, "armed");
  const ack = h.svc.recordAcknowledgment("APP-T12", { kind: "state:AZ", at: MST("2026-10-05", "17:44"), borrower_id: "B-A", method: "esignature", evidence_id: "ESIG-AZ-1" });
  assert.equal(ack.status, "acknowledged"); assert.equal(ack.acknowledged_at, MST("2026-10-05", "17:44")); assert.equal(ack.acknowledgment_evidence_id, "ESIG-AZ-1"); assert.equal(h.emitted("state_notice.acknowledged")[0]!.payload.code, "AZ_ARS_6_946C"); assert.equal(h.emitted("state_notice.acknowledged")[0]!.payload.method, "esignature");
  assert.equal(gate.status, "satisfied"); assert.equal(gate.satisfiedAt, MST("2026-10-05", "17:44"));
  const ok = h.svc.checkCommandGates("APP-T12", "impose_fee", { fee_kind: "appraisal", amount_cents: 65_000n }); assert.equal(ok.result, "open"); assert.equal(ok.gates.find((g) => g.code === GATE)!.result, "open"); assert.equal(h.svc.feeGateChecks("APP-T12").length, 2); assert.equal(h.emitted("gate.refused").length, 1);
  assert.equal(evaluateGate("21.3.azFeeAgreementGate", { property_state: "AZ", acknowledged_at: MST("2026-10-05", "17:44") }).open, true); assert.equal(evaluateGate("21.3.azFeeAgreementGate", { property_state: "AZ", acknowledged_at: null }).open, false);
  // the bus: recordAcknowledgment with a bypass and no logged reason is refused; with evidence it records
  const tools = bindTools(h, "APP-T12");
  await assert.rejects(tools.run("recordAcknowledgment", { application_id: "APP-T12", kind: "state:AZ", at: MST("2026-10-05", "17:44"), borrower_id: "B-A", method: "esignature", evidence_id: "ESIG-AZ-1", bypass_state_gate: true }), (e: unknown) => e instanceof CommandRefused && e.code === "STATE_GATE_BYPASS_UNLOGGED");
  const again = (await tools.run("recordAcknowledgment", { application_id: "APP-T12", kind: "state:AZ", at: MST("2026-10-05", "17:44"), borrower_id: "B-A", method: "esignature", evidence_id: "ESIG-AZ-1" })).output as { status: string }; assert.equal(again.status, "acknowledged");
  assert.ok(registry().activeVersion("NTC_AZ_ARS_6_946C_FEE_AGREEMENT", D("2026-10-05")), "NTC_AZ_ARS_6_946C_FEE_AGREEMENT authored");
});
test("21.3-T13: Given a CA property with `interview_language='es'` and six items Mon Oct 5, when LE v1 is delivered Oct 5, then the DFPI Spanish LE form is delivered with it and `CA_CIV_1632_5_TRANSLATED_LE_3BD` (due Thu Oct 8) is satisfied; when 21.5 delivers LE v2 Thu Oct 8, a matching translated form is delivered the same day; an English-only interview creates no CA §1632.5 row.", () => {
  const h = harness(MST("2026-10-05", "10:00")); h.started("APP-T13", MST("2026-10-05", "10:00"), { property_state: "CA", interview_language: "es", intake_channel: "voice" });
  const p = h.received("APP-T13", MST("2026-10-05", "10:16"), { transaction_type: "limited_cash_out", property_state: "CA", interview_language: "es" });
  const fln = p.rows.find((r) => r.rule_code === "CA_21CCR_7114")!; assert.equal(fln.notice_code, "NTC_CA_21CCR_7114_FAIR_LENDING_NOTICE"); assert.equal(fln.due_at, MST("2026-10-05", "23:59")); assert.equal(fln.acknowledgment_required, true); assert.equal(fln.references.blocking, false);
  assert.equal(p.rows.some((r) => r.rule_code === "CA_CIV_1632_5"), false);   // anchors on the TRID application, not the Reg B application
  const t = h.trid("APP-T13", MST("2026-10-05", "10:41"), { transaction_type: "limited_cash_out", property_state: "CA", interview_language: "es" });
  const v1 = t.translated_le!; assert.equal(v1.kind, "state:CA"); assert.equal(v1.rule_code, "CA_CIV_1632_5"); assert.equal(v1.notice_code, "NTC_CA_CIV_1632_5_TRANSLATED_LE"); assert.equal(v1.language_edition, "es"); assert.equal(v1.le_version, 1); assert.equal(v1.due_at, MST("2026-10-08", "23:59")); assert.equal(v1.timer_code, "CA_CIV_1632_5_TRANSLATED_LE_3BD"); assert.equal(v1.anchor_event, "application.trid_received");
  assert.equal(t.toolkit.language_edition, "en+es"); assert.equal(t.toolkit.required, false);   // the Spanish Toolkit courtesy copy is still offered; the refinance needs no Toolkit
  const timer = h.timer("CA_CIV_1632_5_TRANSLATED_LE_3BD", "APP-T13"); assert.equal(timer.status, "armed"); assert.equal(timer.anchorDate, "2026-10-05"); assert.equal(timer.dueDate, "2026-10-08");
  h.clock.set(MST("2026-10-05", "16:10"));
  const d1 = h.svc.deliver("APP-T13", { rule_code: "CA_CIV_1632_5", le_version: 1, channel: "esign_portal", consent: CONSENT, with_le_disclosure_id: "LE-1" });
  assert.equal(d1.status, "delivered"); assert.equal(d1.delivered_at, MST("2026-10-05", "16:10")); assert.equal(d1.disclosure_id, v1.disclosure_id);
  const ev = h.emitted("state_notice.delivered").find((e) => e.payload.code === "CA_CIV_1632_5")!; assert.equal(ev.payload.le_version, 1); assert.equal(ev.payload.language_edition, "es"); assert.equal(ev.payload.evidence_retained, true);
  assert.equal(h.emitted("disclosure.companion.delivered").find((e) => e.payload.rule_code === "CA_CIV_1632_5")!.payload.with_le_disclosure_id, "LE-1"); assert.equal(timer.status, "satisfied"); assert.equal(timer.satisfiedAt, MST("2026-10-05", "16:10"));
  const f = h.svc.deliver("APP-T13", { rule_code: "CA_21CCR_7114", channel: "esign_portal", consent: CONSENT }); assert.equal(f.status, "delivered"); assert.equal(h.timer("CA_21CCR_7114_FAIR_LENDING_NOTICE_AT_APPLICATION", "APP-T13").status, "satisfied");   // acknowledgment requested, non-blocking
  // LE v2 Thu Oct 8 (21.5 lock): a matching translated form the same day
  h.clock.set(MST("2026-10-08", "11:00")); const v2 = h.svc.onLeRevised("APP-T13", { le_version: 2, at: MST("2026-10-08", "11:00") })!;
  assert.equal(v2.le_version, 2); assert.equal(v2.anchor_event, "disclosure.le.revised"); assert.equal(v2.due_at, MST("2026-10-08", "23:59")); assert.notEqual(v2.disclosure_id, v1.disclosure_id); assert.equal(v2.status, "planned"); assert.equal(h.svc.get(v1.disclosure_id).status, "delivered");
  const d2 = h.svc.deliver("APP-T13", { rule_code: "CA_CIV_1632_5", le_version: 2, channel: "esign_portal", consent: CONSENT, with_le_disclosure_id: "LE-2" });
  assert.equal(d2.disclosure_id, v2.disclosure_id); assert.equal(civilDate(d2.delivered_at!, "America/Phoenix"), "2026-10-08"); assert.equal(h.emitted("state_notice.delivered").filter((e) => e.payload.code === "CA_CIV_1632_5").length, 2);
  assert.equal(h.svc.onLeRevised("APP-T13", { le_version: 1, at: MST("2026-10-08", "11:00") }), null);
  // an English-only interview creates no §1632.5 row (and no clock); a Spanish interview outside CA has no duty
  assert.deepEqual(evaluateStateMatrix({ property_state: "CA", interview_language: "es" }).rows.map((r) => r.rule_code), ["CA_21CCR_7114", "CA_CIV_1632_5"]);
  assert.deepEqual(evaluateStateMatrix({ property_state: "CA", interview_language: "en" }).rows.map((r) => r.rule_code), ["CA_21CCR_7114"]);
  assert.deepEqual(evaluateStateMatrix({ property_state: "CA", interview_language: "zh" }).rows.map((r) => r.rule_code), ["CA_21CCR_7114", "CA_CIV_1632_5"]);
  assert.equal(evaluateStateMatrix({ property_state: "AZ", interview_language: "es" }).rows.some((r) => r.rule_code === "CA_CIV_1632_5"), false);
  const g = harness(MST("2026-10-05", "10:16")); g.received("APP-T13b", MST("2026-10-05", "10:16"), { transaction_type: "limited_cash_out", property_state: "CA", interview_language: "en" });
  const te = g.trid("APP-T13b", MST("2026-10-05", "10:41"), { transaction_type: "limited_cash_out", property_state: "CA", interview_language: "en" });
  assert.equal(te.translated_le, null); assert.equal(g.svc.find("APP-T13b", { rule_code: "CA_CIV_1632_5" }), undefined); assert.equal(g.timers.byCode("CA_CIV_1632_5_TRANSLATED_LE_3BD").filter((x) => x.applicationId === "APP-T13b").length, 0);
  assert.equal(g.svc.onLeRevised("APP-T13b", { le_version: 2, at: MST("2026-10-08", "11:00") }), null); assert.equal(te.toolkit.language_edition, "en");
  assert.ok(registry().activeVersion("NTC_CA_CIV_1632_5_TRANSLATED_LE", D("2026-10-05")) && registry().activeVersion("NTC_CA_21CCR_7114_FAIR_LENDING_NOTICE", D("2026-10-05")), "CA templates authored");
});
test("21.3-T14: Given 23.4 emits `compliance.hpml.determined{is_hpml=true}` Mon Oct 26 09:00 EDT, when the timer is created, then `REGZ_1026_35C5_HPML_APPRAISAL_NOTICE_3BD` shows due Thu Oct 29 and is immediately satisfied by the Oct 22 LE (`satisfied_by_le`); with no prior LE/notice, the standalone notice issues the same day.", () => {
  const CODE = "REGZ_1026_35C5_HPML_APPRAISAL_NOTICE_3BD";
  const h = harness(EDT("2026-10-19", "18:40"), COLUMBUS_CREDITOR); h.received("APP-T14", EDT("2026-10-19", "18:40"), { transaction_type: "purchase", property_state: "OH", borrowers: [BORROWER_A_OH, BORROWER_B_OH] });
  h.clock.set(EDT("2026-10-22", "09:30")); h.svc.markSatisfiedByLE("APP-T14", { disclosure_id: "LE-1", le_version: 1, delivered_at: EDT("2026-10-22", "09:30"), mailed_at: null });
  assert.equal(h.svc.find("APP-T14", { rule_code: "REGB_1002_14A2" })!.status, "satisfied_by_le");
  h.clock.set(EDT("2026-10-26", "09:00")); const r = h.svc.ingestHpmlDetermination("APP-T14", { is_hpml: true, at: EDT("2026-10-26", "09:00"), stage: "rate_set" });
  assert.equal(r.event.type, "compliance.hpml.determined"); assert.equal(r.event.payload.is_hpml, true); assert.equal(r.event.payload.stage, "rate_set"); assert.equal(r.event.applicationId, "APP-T14");
  const row = r.row!; assert.equal(row.rule_code, "REGZ_1026_35C5"); assert.equal(row.kind, "regb_appraisal_notice"); assert.equal(row.timer_code, CODE); assert.equal(row.anchor_event, "compliance.hpml.determined"); assert.equal(row.due_at, EDT("2026-10-29", "23:59"));   // Tue 27, Wed 28, Thu 29
  assert.equal(row.status, "satisfied_by_le"); assert.equal(row.satisfied_by_disclosure_id, "LE-1"); assert.equal(row.standalone_required, false); assert.equal(row.retention_class, "regb_25m");
  const t = h.timer(CODE, "APP-T14"); assert.equal(t.anchorDate, "2026-10-26"); assert.equal(t.dueDate, "2026-10-29"); assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedAt, EDT("2026-10-26", "09:00"));
  const sat = h.emitted("disclosure.companion.satisfied_by_le").filter((e) => e.payload.rule_code === "REGZ_1026_35C5"); assert.equal(sat.length, 1); assert.equal(sat[0]!.payload.le_disclosure_id, "LE-1"); assert.match(sat[0]!.payload.basis as string, /1026\.35\(c\)\(5\)\(i\)/);
  assert.equal(h.emitted("disclosure.companion.issued").find((e) => e.payload.rule_code === "REGZ_1026_35C5")!.payload.via, "le");
  // not an HPML → no (c)(5) row and no clock (worked example 1: is_hpml=false on Oct 7)
  const g0 = harness(MST("2026-10-05", "10:16")); g0.received("APP-T14z", MST("2026-10-05", "10:16"), { transaction_type: "limited_cash_out", property_state: "AZ" });
  const no = g0.svc.ingestHpmlDetermination("APP-T14z", { is_hpml: false, at: MST("2026-10-07", "12:00") }); assert.equal(no.row, null); assert.equal(g0.timers.byCode(CODE).length, 0);
  // no prior LE/notice: the standalone notice issues the same day (issue_by = end of the determination day)
  const g = harness(EDT("2026-10-19", "18:40"), COLUMBUS_CREDITOR); g.received("APP-T14b", EDT("2026-10-19", "18:40"), { transaction_type: "purchase", property_state: "OH", borrowers: [BORROWER_A_OH] });
  g.clock.set(EDT("2026-10-26", "09:00")); const s = g.svc.ingestHpmlDetermination("APP-T14b", { is_hpml: true, at: EDT("2026-10-26", "09:00") });
  assert.equal(s.row!.status, "planned"); assert.equal(s.row!.standalone_required, true); assert.equal(s.row!.standalone_issue_by, EDT("2026-10-26", "23:59")); assert.equal(s.row!.satisfied_by_disclosure_id, null);
  const tb = g.timer(CODE, "APP-T14b"); assert.equal(tb.status, "armed"); assert.equal(tb.dueDate, "2026-10-29");
  const d = g.svc.deliver("APP-T14b", { rule_code: "REGZ_1026_35C5", channel: "esign_portal", consent: CONSENT_B, at: EDT("2026-10-26", "09:40") });
  assert.equal(d.status, "delivered"); assert.equal(d.notice_code, "NTC_REGB_1002_14_APPRAISAL_NOTICE"); assert.equal(civilDate(d.delivered_at!, "America/New_York"), "2026-10-26"); assert.ok(Date.parse(d.delivered_at!) <= Date.parse(s.row!.standalone_issue_by!));
  assert.equal(tb.status, "satisfied"); assert.equal(g.emitted("disclosure.companion.issued").find((e) => e.payload.rule_code === "REGZ_1026_35C5")!.payload.via, "delivered");
  // a prior standalone Reg B notice (delivered) also satisfies (c)(5) at creation
  const k = harness(EDT("2026-10-19", "18:40"), COLUMBUS_CREDITOR); k.received("APP-T14c", EDT("2026-10-19", "18:40"), { transaction_type: "purchase", property_state: null });
  k.clock.set(EDT("2026-10-22", "19:59")); k.svc.deliver("APP-T14c", { kind: "regb_appraisal_notice", channel: "esign_portal", consent: CONSENT_B });
  k.clock.set(EDT("2026-10-26", "09:00")); const kr = k.svc.ingestHpmlDetermination("APP-T14c", { is_hpml: true, at: EDT("2026-10-26", "09:00") }); assert.equal(kr.row!.status, "satisfied_by_le"); assert.equal(kr.row!.satisfied_by_disclosure_id, k.svc.find("APP-T14c", { rule_code: "REGB_1002_14A2" })!.disclosure_id); assert.equal(k.timer(CODE, "APP-T14c").status, "satisfied");
});
test("21.3-T15: Given any forward application, when the plan is created, then a `disclosures` row `kind='sds'` exists with `exempt{reverse_only}` and no `NTC_REGX_1024_33A_SDS` document is ever rendered; the LE's `servicing_intent='service'` (21.2) is referenced in the row.", async () => {
  const h = harness(MST("2026-10-05", "10:16")); const p = h.received("APP-T15", MST("2026-10-05", "10:16"), { transaction_type: "limited_cash_out", property_state: "AZ", le_servicing_intent: "service" });
  const sds = p.rows.find((r) => r.kind === "sds")!; assert.equal(sds.rule_code, "REGX_1024_33A"); assert.equal(sds.required, false); assert.equal(sds.status, "exempt"); assert.equal(sds.exemption_reason, "reverse_only"); assert.equal(sds.notice_code, "NTC_REGX_1024_33A_SDS"); assert.equal(sds.timer_code, null); assert.equal(sds.due_at, null);
  assert.equal(sds.rendered_document_id, null); assert.equal(sds.references.le_servicing_intent, "service"); assert.equal(sds.references.scope, "reverse_only"); assert.equal(SDS_SCOPE, "reverse_only"); assert.match(sds.references.servicing_statement as string, /1026\.37\(m\)\(6\).*intend to service/);
  const ex = h.emitted("disclosure.companion.exempt").find((e) => e.payload.rule_code === "REGX_1024_33A")!; assert.equal(ex.payload.reason, "reverse_only"); assert.equal(ex.payload.kind, "sds");
  assert.throws(() => h.svc.deliver("APP-T15", { kind: "sds", channel: "esign_portal", consent: CONSENT }), (e: unknown) => e instanceof CompanionRefused && e.code === "SDS_NEVER_ISSUED" && /1024\.33\(a\)/.test(e.reason));
  assert.throws(() => h.svc.deliver("APP-T15", { kind: "sds", channel: "mail", mailing_proof_id: "PMV-1" }), (e: unknown) => e instanceof CompanionRefused && e.code === "SDS_NEVER_ISSUED");
  assert.equal(h.svc.get(sds.disclosure_id).rendered_document_id, null); assert.equal(h.svc.get(sds.disclosure_id).status, "exempt"); assert.equal(h.emitted("disclosure.companion.delivered").length, 0); assert.equal(h.emitted("disclosure.companion.delivery.refused").filter((e) => e.payload.kind === "sds").length, 2);
  // every forward transaction type gets the affirmative exemption row; a reverse mortgage (out of scope) would require it
  for (const tt of ["purchase", "cash_out", "construction"]) { const g = harness(MST("2026-10-05", "10:16")); const q = g.received(`APP-T15-${tt}`, MST("2026-10-05", "10:16"), { transaction_type: tt, property_state: "AZ" }); const row = q.rows.find((r) => r.kind === "sds")!; assert.equal(row.status, "exempt", tt); assert.equal(row.exemption_reason, "reverse_only", tt); }
  const rv = harness(MST("2026-10-05", "10:16")).received("APP-T15-rev", MST("2026-10-05", "10:16"), { transaction_type: "reverse", property_state: "AZ" }); assert.equal(rv.rows.find((r) => r.kind === "sds")!.required, true); assert.equal(rv.rows.find((r) => r.kind === "hcl")!.exemption_reason, "reverse_only");
  // the decision record shows the affirmative decision; the bus tools never render the SDS
  const rec = h.svc.decisionRecord("APP-T15", { model_version: "m-2026.09", prompt_version: "p-21.3-v1", rationale: "forward loan: SDS exempt (reverse only); the LE servicing block governs" }) as { rules: { rule_code: string; required: boolean; exemption_reason: string | null }[]; rule_set_versions: { regx: string } };
  const sr = rec.rules.find((r) => r.rule_code === "REGX_1024_33A")!; assert.equal(sr.required, false); assert.equal(sr.exemption_reason, "reverse_only"); assert.equal(rec.rule_set_versions.regx, "regx.2013");
  const tools = bindTools(h, "APP-T15");
  await assert.rejects(tools.run("renderNotice", { application_id: "APP-T15", kind: "sds" }), (e: unknown) => e instanceof CommandRefused && e.code === "SDS_NEVER_ISSUED");
  await assert.rejects(tools.run("renderNotice", { application_id: "APP-T15", kind: "privacy", template_code: "NTC_REGX_1024_33A_SDS" }), (e: unknown) => e instanceof CommandRefused && e.code === "SDS_NEVER_ISSUED");
  await assert.rejects(tools.run("deliver", { application_id: "APP-T15", kind: "sds", channel: "mail", mailing_proof_id: "PMV-1" }), (e: unknown) => e instanceof CommandRefused && e.code === "SDS_NEVER_ISSUED");
  const ex2 = (await tools.run("evaluateExemptions", { transaction_type: "limited_cash_out" })).output as { sds: { required: boolean; exemption_reason: string; scope: string }; toolkit: { exemption_reason: string } }; assert.deepEqual(ex2.sds, { required: false, exemption_reason: "reverse_only", scope: "reverse_only" }); assert.equal(ex2.toolkit.exemption_reason, "refinance_no_toolkit");
  const v = registry().activeVersion("NTC_REGX_1024_33A_SDS", D("2026-10-05")); assert.ok(v, "the SDS template is retained in the registry (scope reverse_only)");
});
test("21.3-T16: Given the privacy notice was delivered only by the AI reading it aloud on a voice call, when `compliance-sentinel` scans, then the row is not `delivered` (§1016.9(d)) and a sev-2 escalation opens; a mailed copy the same day satisfies it.", async () => {
  const h = harness(MST("2026-10-05", "10:16")); const p = h.received("APP-T16", MST("2026-10-05", "10:16"), { transaction_type: "limited_cash_out", property_state: "AZ" });
  const priv = p.rows.find((r) => r.kind === "privacy")!; assert.equal(priv.rule_code, "GLBA_1016_4"); assert.equal(priv.notice_code, "NTC_GLBA_1016_4_PRIVACY_INITIAL"); assert.equal(priv.asset_version, PRIVACY_EDITION); assert.equal(priv.acknowledgment_required, true); assert.equal(priv.due_at, MST("2026-10-08", "23:59"));
  h.clock.set(MST("2026-10-05", "10:30"));
  assert.throws(() => h.svc.deliver("APP-T16", { kind: "privacy", channel: "oral" }), (e: unknown) => e instanceof CompanionRefused && e.code === "ORAL_NOT_DELIVERY" && /1016\.9\(d\)/.test(e.reason));
  const row = h.svc.get(priv.disclosure_id); assert.equal(row.status, "planned"); assert.notEqual(row.status, "delivered"); assert.equal(row.delivered_at, null); assert.equal(row.mailed_at, null); assert.equal(row.oral_explanation_at, MST("2026-10-05", "10:30"));
  assert.equal(h.emitted("privacy.initial_notice.delivered").length, 0); assert.equal(h.emitted("disclosure.companion.delivery.refused")[0]!.payload.channel, "oral"); assert.equal(h.timer("SM_O23_PRIVACY_INITIAL_3BD", "APP-T16").status, "armed");
  const scan = h.svc.sentinelScan("APP-T16", MST("2026-10-05", "12:00")); assert.equal(scan.findings.length, 1); assert.equal(scan.findings[0]!.code, "GLBA_1016_9D_ORAL_ONLY"); assert.equal(scan.findings[0]!.severity, 2); assert.equal(scan.findings[0]!.disclosure_id, priv.disclosure_id);
  const sev2 = h.escalations.list().filter((e) => e.kind === "sev2"); assert.equal(sev2.length, 1); assert.equal(sev2[0]!.severity, "2"); assert.equal(sev2[0]!.openedBy, "agent:compliance-sentinel"); assert.equal(sev2[0]!.ownerRole, "compliance"); assert.equal(sev2[0]!.id, scan.findings[0]!.escalation_id); assert.equal(sev2[0]!.payload.oral_explanation_at, MST("2026-10-05", "10:30"));
  // the bus refuses the oral channel before the service is even reached
  const tools = bindTools(h, "APP-T16");
  await assert.rejects(tools.run("deliver", { application_id: "APP-T16", kind: "privacy", channel: "oral" }), (e: unknown) => e instanceof CommandRefused && e.code === "ORAL_NOT_DELIVERY");
  await assert.rejects(tools.run("deliver", { application_id: "APP-T16", kind: "privacy", channel: "email", at: MST("2026-10-05", "14:00") }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_ESIGN_CONSENT");
  const consent = (await tools.run("assertConsent", { channel: "oral" })).output as { ok: boolean }; assert.equal(consent.ok, false);
  // a mailed copy the same day satisfies the clock (written delivery, §1016.9(b)(1))
  const m = (await tools.run("deliver", { application_id: "APP-T16", kind: "privacy", channel: "mail", mailing_proof_id: "PMV-2026-10-05-0001", at: MST("2026-10-05", "15:00") })).output as { status: string; mailed_at: string; mailing_proof_id: string };
  assert.equal(m.status, "mailed"); assert.equal(civilDate(m.mailed_at, "America/Phoenix"), "2026-10-05"); assert.equal(m.mailing_proof_id, "PMV-2026-10-05-0001");
  const ev = h.emitted("privacy.initial_notice.delivered")[0]!; assert.equal(ev.payload.channel, "mail"); assert.equal(ev.payload.edition, PRIVACY_EDITION); assert.equal(ev.payload.acknowledgment_as_step, false);
  assert.equal(h.timer("SM_O23_PRIVACY_INITIAL_3BD", "APP-T16").status, "satisfied"); assert.equal(h.timer("SM_O23_PRIVACY_INITIAL_3BD", "APP-T16").satisfiedAt, MST("2026-10-05", "15:00"));
  assert.equal(h.svc.sentinelScan("APP-T16", MST("2026-10-06", "09:00")).findings.length, 0); assert.equal(h.escalations.list().filter((e) => e.kind === "sev2").length, 1);
  // the portal path: electronic delivery with the acknowledgment as a step (worked example 1: acknowledged 17:41)
  const g = harness(MST("2026-10-05", "10:16")); g.received("APP-T16b", MST("2026-10-05", "10:16"), { transaction_type: "limited_cash_out", property_state: "AZ" }); g.clock.set(MST("2026-10-05", "16:10"));
  const e = g.svc.deliver("APP-T16b", { kind: "privacy", channel: "esign_portal", consent: CONSENT }); assert.equal(e.status, "delivered"); assert.equal(g.emitted("privacy.initial_notice.delivered")[0]!.payload.acknowledgment_as_step, true);
  const ack = g.svc.recordAcknowledgment("APP-T16b", { kind: "privacy", at: MST("2026-10-05", "17:41"), borrower_id: "B-A", method: "portal_step", evidence_id: "ACK-PRIV-1" }); assert.equal(ack.status, "acknowledged"); assert.equal(g.timer("SM_O23_PRIVACY_INITIAL_3BD", "APP-T16b").status, "satisfied");
  assert.equal(g.svc.sentinelScan("APP-T16b", MST("2026-10-06", "09:00")).findings.length, 0);
});

test("21.3 worked figures: Plan 4927 $10,000 illustration ($59.15 initial P&I; 10.875 % reached after 78 months) and the fixtures' companion due dates", async () => {
  // rule 7 worked arithmetic: 10,000 × 0.0048958333 ÷ (1 − 1.0048958333⁻³⁶⁰) = $59.15 (half-up at the cent)
  const ill = armIllustration("4927", "5.875", "2026-10");
  assert.equal(ill.loan_cents, 1_000_000n); assert.equal(ill.term_months, 360); assert.equal(ill.initial_payment_cents, 5_915n); assert.equal(formatCentsUsd(ill.initial_payment_cents), "$59.15");
  assert.equal(levelPayment(1_000_000n, ratePercent("5.875"), 360), 5_915n);
  // maximum rate 5.875 + 5.000 = 10.875 %, reached after the first change (+2) and three subsequent changes (+1 each): months 61, 67, 73, 79 → 78 months after origination
  assert.equal(ill.max_rate_pct, "10.875"); assert.equal(ill.months_to_max_rate, 78);
  assert.deepEqual(ill.rate_path.map((r) => [r.from_month, r.rate_pct]), [[1, "5.875"], [61, "7.875"], [67, "8.875"], [73, "9.875"], [79, "10.875"]]);
  // the maximum payment re-amortizes the then-remaining balance over the remaining 282 months at 10.875 %
  assert.equal(ill.max_payment_cents, levelPayment(ill.balance_at_max_cents, ratePercent("10.875"), 360 - 78)); assert.ok(ill.max_payment_cents > ill.initial_payment_cents); assert.ok(ill.balance_at_max_cents < ill.loan_cents && ill.balance_at_max_cents > 0n);
  assert.equal(ill.rate_path.at(-1)!.payment_cents, ill.max_payment_cents);
  const d = armProgramDisclosure("4927", ill); assert.equal(d.label, "5/6 SOFR"); assert.deepEqual(d.caps, { first: "2", subsequent: "1", lifetime: "5" });
  assert.match(d.content_items[7]!.text, /initial monthly principal and interest \$59\.15; maximum interest rate 10\.875%, which could be reached after 78 months/); assert.match(d.content_items[7]!.text, /may increase or decrease substantially depending on changes in the rate/);
  assert.match(armProgramDisclosure("4927", ill, { discounted: true }).content_items[4]!.text, /ask us about the amount of the interest rate discount/);
  // the registry template reproduces the same figures and its worked-figure rule passes on the process's numbers
  const v = registry().activeVersion("NTC_REGZ_1026_19B_ARM_PROGRAM", D("2026-10-05")); assert.ok(v); const tpl = armTemplatePayload(d); const rendered = render(v!.source, tpl);
  assert.match(rendered.text, /initial monthly principal and interest payment is \$59\.15/); assert.match(rendered.text, /maximum interest rate is 10\.875 percent, which could be reached at the earliest 78 months after origination/);
  const check = evaluateChecklist(v!, tpl, rendered); assert.equal(check.passed, true); assert.deepEqual(check.blocking, []);
  // the bus reproduces it
  const h = harness(MST("2026-10-05", "10:16")); const via = (await bindTools(h, "APP-WF").run("renderArmProgramDisclosure", { fnma_plan_number: "4927", initial_rate_pct: "5.875", illustration_as_of: "2026-10" })).output as ArmProgramDisclosure;
  assert.equal(via.illustration.initial_payment_cents, 5_915n); assert.equal(via.illustration.months_to_max_rate, 78);
  // worked examples 1–3: the companion due dates on the two creditor calendars
  assert.equal(companionDueAt(MST("2026-10-05", "10:16"), 3, PHOENIX_CREDITOR).due_at, MST("2026-10-08", "23:59"));      // WE1: Tue 6, Wed 7, Thu 8
  assert.equal(companionDueAt(MST("2026-10-05", "11:05"), 1, PHOENIX_CREDITOR).due_on, "2026-10-06");                    // WE1: score notice due Tue Oct 6 EOD
  assert.equal(companionDueAt(EDT("2026-10-19", "18:40"), 3, COLUMBUS_CREDITOR).due_at, EDT("2026-10-22", "23:59"));     // WE2(a): Tue 20, Wed 21, Thu 22
  assert.equal(companionDueAt(EDT("2026-10-20", "09:05"), 1, COLUMBUS_CREDITOR).due_on, "2026-10-21");                   // WE2(a): score notices Wed Oct 21 EOD
  assert.equal(companionDueAt(MST("2026-10-08", "09:00"), 3, PHOENIX_CREDITOR).due_on, "2026-10-14");                    // WE2(b): Fri 9, Tue 13, Wed 14
  assert.equal(companionDueAt(EDT("2026-10-26", "09:00"), 3, COLUMBUS_CREDITOR).due_on, "2026-10-29");                   // WE2(d): HPML statement Thu Oct 29
  assert.equal(companionDueAt(MST("2026-10-05", "10:41"), 3, PHOENIX_CREDITOR).due_on, "2026-10-08");                    // WE3(b): CA §1632.5 Thu Oct 8
});
