// 18.6 Reg AB / USAP attestation
// spec/sections/18-qc-audit-regulatory-reporting/18-6-reg-ab-usap-attestation.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays, addMonths } from "../../kernel/calendar/date.ts";
import { exceptionList, removeException, generateControlEvidence, materialNoncompliance, type ControlException } from "./ops.ts";
import { REGAB_TIMERS, RECON_ITEM_SUBJECT, regAbApplicability, regAbClocks, attestationCycleEvent, packageTransition, officerSignatureRecord, reconItemControlException, controlExceptions, controlEvidenceBinder, evidenceCompleteness, evidenceDocumentsOnFile, exceptionRegister, classifyReconItem, reconItemResolvedView, applicabilityConflicts, auditorReportCheck, assessmentWarning, assessmentPeriod, assessmentReport, subCertification, materialNoncomplianceDisclosure, type PackageTransitionResult } from "./ops-18-6.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { eventMatches, MemoryEventStore, FixedClock, SYSTEM, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { ATTESTATION_TOOLS_18_6, TOOLS_18_6, EXCEPTIONS, attestationReactors_18_6 } from "../../app/tools/section18-6.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";

const AGENT: Actor = { kind: "agent", id: "qc-audit" };
const OFFICER: Actor = { kind: "human", id: "officer-7", role: "officer" };
const SIGNATURE = { officer_id: "officer-7", signer_role: "officer", signed_at: "2027-02-10T15:00:00.000Z", document_id: "doc-assert-2026" };
const MATRIX = [{ control_code: "CTL-2VII-RECON", criterion: "1122.d.2.vii", frequency: "monthly" as const }, { control_code: "CTL-4X-ESCROW", criterion: "1122.d.4.x", frequency: "annual" as const }];
const STMT_ITEM = { category: "control_total_mismatch", kind: "statement", file_id: "stmt-CUST-PI-ABS-2026-10-01", first_seen_on: "2026-10-01" };   // §6.3 bank.read_statement payload, verbatim shape
type Bus = ReturnType<typeof bus18_6>;

/** A one-process bus over the 18.6 attestation tools with the overridden registry's 18.6 timers armed by their events and the module's reactors wired. */
function bus18_6(nowIso: string, opts: { all_processes?: boolean } = {}): { bus: CommandBus; clock: FixedClock; ctx: UowContext & { decisions: DecisionInput[] }; rt: ToolRuntime; run: (name: string, input: Record<string, unknown>, actor?: Actor) => Promise<unknown> } {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, opts.all_processes ? {} : { processes: ["18.6"] });
  const ctx = { loanId: "", events, ledger: new MemoryLedger(), timers, clock, decide: (d: DecisionInput) => { decisions.push(d); }, decisions } as UowContext & { decisions: DecisionInput[] };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  attestationReactors_18_6({ events, timers, store: rt.store });
  const agents = new AgentRegistry(); const bus = new CommandBus(agents);
  const escalates = loadAgentsFile().processes.find((p) => p.process === "18.6")!.escalates_to;
  const cmds = new Map(ATTESTATION_TOOLS_18_6.map((d) => { const c = toolCommand(d, rt, escalates); agents.registerTool(d.agent, c.name); return [d.name, c] as const; }));
  return { bus, clock, ctx, rt, run: (name, input, actor = AGENT) => bus.execute(cmds.get(name)!, actor, input, ctx).then((r) => r.output) };
}
const dueByCode = (ctx: UowContext): Record<string, string | null> => Object.fromEntries(ctx.timers.all().map((t) => [t.code, t.dueDate ?? null]));
/** Monthly evidence documents for every month of the window plus one annual document — a binder complete at each control's frequency. */
function fullEvidence(start: string, end: string): { control_code: string; occurred_on: string; document_id: string }[] {
  const out: { control_code: string; occurred_on: string; document_id: string }[] = [];
  for (let m = D(start); m <= D(end); m = addMonths(m, 1)) out.push({ control_code: "CTL-2VII-RECON", occurred_on: addDays(addMonths(m, 1), -1), document_id: `recon-${m.slice(0, 7)}` });
  out.push({ control_code: "CTL-4X-ESCROW", occurred_on: addDays(D(start), 100), document_id: `escrow-analysis-${start.slice(0, 4)}` });
  return out;
}
/** The registered-ABS program P-ABS (custodial account CUST-PI-ABS, partner Partner Bank) with its cycle opened for FYE 2026-12-31. */
async function openAbsCycle(b: Bus): Promise<{ cycle_id: string; pkg: string }> {
  await b.run("investor_program.create", { id: "P-ABS", investor: "PL Trust 2026-1", program_kind: "private_abs_registered", psa_assessment_days: 60, partner_entity: "Partner Bank", custodial_account_ids: ["CUST-PI-ABS"] });
  const c = await b.run("attestation.cycle.open", { entity: "Supermortgage", fye: "2026-12-31", program_id: "P-ABS" }) as { cycle_id: string };
  return { cycle_id: c.cycle_id, pkg: `${c.cycle_id}:regab_1122_assessment` };
}
/** Every cited evidence document filed in `documents` with its hash — a binder cites only documents on file (Audit: "evidence binders with hashes"). */
function fileDocs(b: Bus, evidence: readonly { document_id: string }[]): void {
  for (const e of evidence) if (!b.rt.store.get("documents", e.document_id)) b.rt.store.put("documents", e.document_id, { id: e.document_id, kind: "control_evidence", sha256: `sha256:${e.document_id}` }, SYSTEM, b.clock.now());
}
/** The matrix on file and a complete binder (of filed documents) for the package's period — what `evidence_compiled` reads. */
async function compileEvidence(b: Bus, pkg: string): Promise<void> {
  await b.run("control_matrix.upsert", { rows: MATRIX });
  const p = b.rt.store.get("attestation_packages", pkg)!.data as { period_start: string; period_end: string };
  const evidence = fullEvidence(p.period_start, p.period_end); fileDocs(b, evidence);
  await b.run("control_evidence.generate", { package_id: pkg, evidence });
}

test("18.6-T1: Given an investor program `fnma_mbs`, then `regab_applicable=false` and no `REGAB_*` timers start.", async () => {
  // rule 18.6-1: Fannie Mae MBS are exempt securities (12 U.S.C. 1719(d)) — no Reg AB filing; a SOC 1 Type II is still produced (open question 1)
  const a = regAbApplicability({ program_kind: "fnma_mbs" });
  assert.equal(a.regab_applicable, false); assert.equal(a.usap_contractual, false); assert.deepEqual(a.regab_timers, []); assert.deepEqual(a.deliverables, ["soc1_type2"]); assert.match(a.basis, /12 U\.S\.C\. 1719\(d\)/);
  assert.equal(regAbApplicability({ program_kind: "fnma_portfolio" }).regab_applicable, false);
  const abs = regAbApplicability({ program_kind: "private_abs_registered" });
  assert.equal(abs.regab_applicable, true); assert.deepEqual(abs.regab_timers, [...REGAB_TIMERS]); assert.deepEqual(abs.deliverables, ["regab_1122_assessment", "regab_1123_statement", "soc1_type2"]);
  const whole = regAbApplicability({ program_kind: "private_whole_loan", usap_requested: true });
  assert.equal(whole.regab_applicable, false); assert.equal(whole.usap_contractual, true); assert.deepEqual(whole.deliverables, ["soc1_type2", "usap"]); assert.deepEqual(whole.regab_timers, []);
  // every REGAB_* registry row triggers only on `{regab_applicable=true}`; the Fannie Mae cycle event does not match any of them
  const reg = loadOverriddenRegistry();
  const cycle = attestationCycleEvent({ entity: "Supermortgage", fye: D("2026-12-31"), program: { id: "P-FNMA", program_kind: "fnma_mbs" } });
  assert.equal(cycle.type, "attestation.cycle.opened"); assert.equal(cycle.payload.regab_applicable, false); assert.deepEqual(cycle.applicability.regab_timers, []);
  const ev: DomainEvent = { id: "e1", type: cycle.type, occurredAt: "2026-12-31T22:00:00.000Z", aggregate: cycle.aggregate, actor: SYSTEM, payload: cycle.payload, sequence: 1 };
  for (const code of REGAB_TIMERS) { const t = reg.get(code)!; assert.match(t.triggerPattern!.raw, /regab_applicable=true/, code); assert.equal(eventMatches(t.triggerPattern!, ev), false, `${code} must not arm for fnma_mbs`); }
  assert.equal(eventMatches(reg.get("REGAB_1122_ASSESSMENT_PSA_DUE")!.triggerPattern!, { ...ev, payload: { ...ev.payload, regab_applicable: true } }), true);
  // through the bus and the timer engine: onboarding + cycle open for the Fannie Mae program arms no REGAB_* timer — the SOC 1, evidence and assertion clocks still run
  const b = bus18_6("2026-12-31T22:00:00.000Z");
  const p = await b.run("investor_program.create", { id: "P-FNMA", investor: "Fannie Mae", program_kind: "fnma_mbs", custodial_account_ids: ["CUST-PI-FNMA"] }) as { regab_applicable: boolean; regab_timers: string[]; deliverables: string[] };
  assert.equal(p.regab_applicable, false); assert.deepEqual(p.regab_timers, []); assert.deepEqual(p.deliverables, ["soc1_type2"]);
  assert.equal(b.ctx.events.ofType("investor_program.created")[0]!.payload.regab_applicable, false);
  const c = await b.run("attestation.cycle.open", { entity: "Supermortgage", fye: "2026-12-31", program_id: "P-FNMA" }) as { regab_applicable: boolean; regab_timers: string[] };
  assert.equal(c.regab_applicable, false); assert.deepEqual(c.regab_timers, []);
  for (const code of REGAB_TIMERS) assert.deepEqual(b.ctx.timers.byCode(code), [], `${code} must not start`);
  assert.deepEqual(dueByCode(b.ctx), { SM_ATTEST_EVIDENCE_COMPILE_FYE_15: "2027-01-15", SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45: "2027-02-14", SM_SOC1_TYPE2_ANNUAL: "2027-03-16" });
  // the cycle reads the *recorded* determination (prerequisite: applicability recorded per investor/pool; rule 18.6-1 at onboarding): a caller cannot open the Fannie Mae program as registered ABS (no REGAB_* clock, no 1122/1123 package, the record untouched), nor a registered-ABS program as Fannie Mae, nor a program never recorded
  const fnma = { id: "P-FNMA", program_kind: "fnma_mbs" as const, psa_assessment_days: null, psa_statement_days: null, usap_requested: false, criteria_applicable: [], partner_entity: null };
  assert.match(applicabilityConflicts(fnma, { program_kind: "private_abs_registered" })[0]!, /program_kind private_abs_registered conflicts with the recorded applicability determination of P-FNMA \(fnma_mbs, rule 18\.6-1\)/);
  assert.deepEqual(applicabilityConflicts(fnma, { program_kind: "fnma_mbs", psa_assessment_days: 60, usap_requested: false }), []);   // a restatement equal to the record is tolerated
  assert.match(applicabilityConflicts(fnma, { psa_assessment_days: 90 })[0]!, /psa_assessment_days 90 conflicts with the recorded PSA deliverable rule/);
  await assert.rejects(b.run("attestation.cycle.open", { entity: "Supermortgage", fye: "2027-12-31", program_id: "P-FNMA", program_kind: "private_abs_registered" }), (e: unknown) => e instanceof RangeError && /reads the recorded determination, never the caller's: program_kind private_abs_registered conflicts/.test((e as Error).message));
  for (const code of REGAB_TIMERS) assert.deepEqual(b.ctx.timers.byCode(code), [], `${code} must not start on a caller's program_kind`);
  assert.deepEqual(b.rt.store.list("attestation_packages").map((p) => p.data.kind), ["soc1_type2"]); assert.equal(b.ctx.events.ofType("attestation.cycle.opened").length, 1);
  assert.deepEqual([b.rt.store.get("investor_programs", "P-FNMA")!.data.program_kind, b.rt.store.get("investor_programs", "P-FNMA")!.data.regab_applicable], ["fnma_mbs", false]);
  await b.run("investor_program.create", { id: "P-ABS-R", investor: "PL Trust 2026-2", program_kind: "private_abs_registered" });
  await assert.rejects(b.run("attestation.cycle.open", { entity: "Supermortgage", fye: "2026-12-31", program_id: "P-ABS-R", program_kind: "fnma_mbs" }), (e: unknown) => e instanceof RangeError && /program_kind fnma_mbs conflicts with the recorded applicability determination of P-ABS-R \(private_abs_registered/.test((e as Error).message));
  assert.equal(b.ctx.events.ofType("attestation.cycle.opened").length, 1); for (const code of REGAB_TIMERS) assert.deepEqual(b.ctx.timers.byCode(code), []);
  await assert.rejects(b.run("attestation.cycle.open", { entity: "Supermortgage", fye: "2026-12-31", program_id: "P-NOWHERE", program_kind: "private_abs_registered" }), (e: unknown) => e instanceof RangeError && /no investor_programs P-NOWHERE — investor_program.create records the applicability determination first/.test((e as Error).message));
  const absCycle = await b.run("attestation.cycle.open", { entity: "Supermortgage", fye: "2026-12-31", program_id: "P-ABS-R", program_kind: "private_abs_registered" }) as { program_kind: string; regab_applicable: boolean };   // equal to the record: tolerated
  assert.deepEqual([absCycle.program_kind, absCycle.regab_applicable], ["private_abs_registered", true]); assert.equal(b.ctx.timers.byCode("REGAB_1122_ASSESSMENT_PSA_DUE").length, 1);
  // a §6.3 reconciling item (bank.read_statement's own payload shape) on the Fannie Mae custodial account: the reactor derives the Reg AB view as not applicable — it ages under §6.3 only, the (2)(vii) Reg AB clock does not start
  b.ctx.events.append({ type: "reconciliation_item.opened", aggregate: { kind: "custodial_account", id: "CUST-PI-FNMA" }, actor: SYSTEM, payload: { ...STMT_ITEM, file_id: "stmt-CUST-PI-FNMA-2026-10-01" } });
  const derived = b.ctx.events.ofType("regab.reconciling_item.opened"); assert.equal(derived.length, 1);
  assert.equal(derived[0]!.payload.regab_applicable, false); assert.equal(derived[0]!.payload.program_id, "P-FNMA"); assert.equal(derived[0]!.payload.item_date, "2026-10-01"); assert.match(String(derived[0]!.payload.basis), /not regab_applicable \(rule 18\.6-1\)/);
  assert.deepEqual(b.ctx.timers.byCode("REGAB_1122_2VII_RECON_ITEMS_90"), []);
  // an account mapped to no program is not applicable either (the clock never starts on a guess); the classifier says why
  assert.match(classifyReconItem({ source_event_id: "x", item_id: "RI-9", account_id: "CUST-UNKNOWN", first_seen_on: null, event_date: D("2026-10-01"), program: null }).payload.basis, /mapped to no investor program/);
  // an unknown program kind is refused at onboarding (data model enum), never silently mapped
  await assert.rejects(b.run("investor_program.create", { id: "P-X", investor: "X", program_kind: "registered_abs" }), (e: unknown) => e instanceof RangeError && /program_kind registered_abs/.test((e as Error).message));
});
test("18.6-T2: Given a registered private-label pool with PSA deliverable FYE + 60 and FYE 2026-12-31, then the assessment/attestation deadline is 2027-03-01 with a warning 2027-01-30 and the assertion due 2027-02-14.", async () => {
  const c = regAbClocks(D("2026-12-31"), { assessment_days: 60 });
  assert.deepEqual(c, { fye: D("2026-12-31"), attestation_due: D("2027-03-01"), statement_due: D("2027-03-01"), warning: D("2027-01-30"), assertion_due: D("2027-02-14"), evidence_due: D("2027-01-15"), soc1_due: D("2027-03-16"), psa_default_applied: false });
  // open question 2: FYE + 60 is the default until the PSA is loaded
  const dflt = regAbClocks(D("2026-12-31")); assert.equal(dflt.psa_default_applied, true); assert.equal(dflt.attestation_due, D("2027-03-01"));
  // a PSA at FYE + 90 (the issuer's 10-K date) moves only the deliverable — the warning (FYE + 30) and the assertion (FYE + 45) are fixed by the timer table
  const psa90 = regAbClocks(D("2026-12-31"), { assessment_days: 90, statement_days: 75 });
  assert.deepEqual([psa90.attestation_due, psa90.statement_due, psa90.warning, psa90.assertion_due], [D("2027-03-31"), D("2027-03-16"), D("2027-01-30"), D("2027-02-14")]);
  // through the bus and the timer engine: the cycle event anchors REGAB_1122_ASSESSMENT_PSA_DUE / REGAB_1123_STATEMENT_PSA_DUE on the PSA dates and the SM_ clocks on FYE
  const b = bus18_6("2026-12-31T22:00:00.000Z");
  await b.run("investor_program.create", { id: "P-ABS", investor: "PL Trust 2026-1", program_kind: "private_abs_registered", psa_assessment_days: 60, partner_entity: "Partner Bank" });
  const r = await b.run("attestation.cycle.open", { entity: "Supermortgage", fye: "2026-12-31", program_id: "P-ABS" }) as { cycle_id: string; regab_applicable: boolean; regab_timers: string[]; deliverables: string[]; period: { start: string; end: string }; clocks: ReturnType<typeof regAbClocks> };
  assert.equal(r.regab_applicable, true); assert.deepEqual(r.regab_timers, [...REGAB_TIMERS]); assert.equal(r.clocks.attestation_due, D("2027-03-01")); assert.equal(r.clocks.warning, D("2027-01-30")); assert.equal(r.clocks.assertion_due, D("2027-02-14"));
  assert.deepEqual(r.period, { start: "2026-01-01", end: "2026-12-31" });
  assert.deepEqual(dueByCode(b.ctx), { REGAB_1122_ASSESSMENT_PSA_DUE: "2027-03-01", REGAB_1123_STATEMENT_PSA_DUE: "2027-03-01", SM_ATTEST_EVIDENCE_COMPILE_FYE_15: "2027-01-15", SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45: "2027-02-14", SM_SOC1_TYPE2_ANNUAL: "2027-03-16" });
  const fye = b.ctx.events.ofType("attestation.cycle.opened")[0]!;
  assert.equal(fye.payload.fye, "2026-12-31"); assert.equal(fye.payload.psa_assessment_due, "2027-03-01"); assert.equal(fye.payload.warning_on, "2027-01-30"); assert.equal(fye.payload.assertion_due, "2027-02-14"); assert.deepEqual(fye.aggregate, { kind: "attestation_cycle", id: r.cycle_id });
  assert.deepEqual(b.rt.store.list("attestation_packages").map((p) => [p.data.kind, p.data.status, p.data.period_start, p.data.period_end]), [["regab_1122_assessment", "planned", "2026-01-01", "2026-12-31"], ["regab_1123_statement", "planned", "2026-01-01", "2026-12-31"], ["soc1_type2", "planned", "2026-01-01", "2026-12-31"]]);
  // the clocks anchor on FYE, not on the day the cycle is opened: opened 2027-01-05 for FYE 2026-12-31 the dues are unchanged (evidence 01-15, assertion 02-14, SOC 1 03-16, PSA 03-01)
  const late = bus18_6("2027-01-05T15:00:00.000Z");
  await late.run("investor_program.create", { id: "P-ABS-LATE", investor: "PL Trust 2026-1", program_kind: "private_abs_registered", psa_assessment_days: 60 });
  await late.run("attestation.cycle.open", { entity: "Supermortgage", fye: "2026-12-31", program_id: "P-ABS-LATE" });
  assert.deepEqual(dueByCode(late.ctx), { REGAB_1122_ASSESSMENT_PSA_DUE: "2027-03-01", REGAB_1123_STATEMENT_PSA_DUE: "2027-03-01", SM_ATTEST_EVIDENCE_COMPILE_FYE_15: "2027-01-15", SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45: "2027-02-14", SM_SOC1_TYPE2_ANNUAL: "2027-03-16" });
  assert.ok(late.ctx.timers.all().every((t) => t.anchorDate === "2026-12-31" || t.anchorDate === "2027-03-01"), "every 18.6 clock anchors on FYE or the PSA date");
  // the cycle event is the module's own: against the whole registry (no process filter) it arms exactly the five 18.6 rows — never §18.4/§19's Form 582, AFS or ISBR clocks — and the corporate `period.fiscal_year_end` arms none of the 18.6 rows
  const all = bus18_6("2026-12-31T22:00:00.000Z", { all_processes: true });
  await all.run("investor_program.create", { id: "P-ABS", investor: "PL Trust 2026-1", program_kind: "private_abs_registered", psa_assessment_days: 60 });
  await all.run("attestation.cycle.open", { entity: "Supermortgage", fye: "2026-12-31", program_id: "P-ABS" });
  assert.deepEqual(all.ctx.timers.all().map((t) => t.code).sort(), ["REGAB_1122_ASSESSMENT_PSA_DUE", "REGAB_1123_STATEMENT_PSA_DUE", "SM_ATTEST_EVIDENCE_COMPILE_FYE_15", "SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45", "SM_SOC1_TYPE2_ANNUAL"]);
  all.ctx.events.append({ type: "period.fiscal_year_end", aggregate: { kind: "fiscal_year", id: "Supermortgage:2026" }, actor: SYSTEM, payload: { entity: "Supermortgage", fye: "2026-12-31", regab_applicable: true } });
  assert.equal(all.ctx.timers.all().filter((t) => t.code.startsWith("REGAB_") || t.code.startsWith("SM_ATTEST_") || t.code === "SM_SOC1_TYPE2_ANNUAL").length, 5, "the corporate FYE event arms no 18.6 clock");
  // the same program with a PSA at FYE + 90: the deadline moves to 2027-03-31, the assertion clock does not
  const b90 = bus18_6("2026-12-31T22:00:00.000Z");
  await b90.run("investor_program.create", { id: "P-ABS-90", investor: "PL Trust 2026-3", program_kind: "private_abs_registered", psa_assessment_days: 90 });
  await b90.run("attestation.cycle.open", { entity: "Supermortgage", fye: "2026-12-31", program_id: "P-ABS-90" });
  assert.equal(dueByCode(b90.ctx).REGAB_1122_ASSESSMENT_PSA_DUE, "2027-03-31"); assert.equal(dueByCode(b90.ctx).SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45, "2027-02-14");
  // the PSA deliverable rule is the recorded one (open question 2: FYE + 60 until each PSA is loaded): a caller cannot move the deadline at cycle open — the record is
  await assert.rejects(b.run("attestation.cycle.open", { entity: "Supermortgage", fye: "2027-12-31", program_id: "P-ABS", psa_assessment_days: 90 }), (e: unknown) => e instanceof RangeError && /psa_assessment_days 90 conflicts with the recorded PSA deliverable rule of P-ABS \(60\)/.test((e as Error).message));
  assert.equal(b.ctx.events.ofType("attestation.cycle.opened").length, 1);
  // the warning at FYE + 30 is a behaviour: on 2027-01-29 nothing; on 2027-01-30, with the assessment undelivered, the officer is escalated once (`attestation.warning.raised`), never twice
  assert.deepEqual(assessmentWarning({ warning_on: D("2027-01-30"), due: D("2027-03-01"), as_of: D("2027-01-29"), delivered: false, already_raised: false }).raise, false);
  assert.deepEqual(assessmentWarning({ warning_on: D("2027-01-30"), due: D("2027-03-01"), as_of: D("2027-01-30"), delivered: true, already_raised: false }).raise, false);
  const quiet = await b.run("attestation.warning.check", { as_of: "2027-01-29" }) as { cycles: { raised: boolean; reason: string }[] };
  assert.equal(quiet.cycles.length, 1); assert.equal(quiet.cycles[0]!.raised, false); assert.match(quiet.cycles[0]!.reason, /2027-01-30 \(FYE \+ 30\) not reached/);
  b.clock.set("2027-01-30T15:00:00.000Z");
  const warned = await b.run("attestation.warning.check", { as_of: "2027-01-30" }) as { cycles: { cycle_id: string; raised: boolean; escalation_id?: string; reason: string }[] };
  assert.equal(warned.cycles[0]!.raised, true); assert.match(warned.cycles[0]!.reason, /due 2027-03-01 \(REGAB_1122_ASSESSMENT_PSA_DUE\)/);
  const esc = b.rt.escalations.opened; assert.equal(esc.length, 1); assert.equal(esc[0]!.kind, "officer"); assert.equal(esc[0]!.severity, "warning"); assert.equal(esc[0]!.payload.code, "REGAB_1122_ASSESSMENT_PSA_DUE"); assert.equal(esc[0]!.payload.warning_on, "2027-01-30"); assert.equal(esc[0]!.payload.partner, "Partner Bank");
  assert.equal(b.ctx.events.ofType("attestation.warning.raised").length, 1); assert.equal(b.ctx.events.ofType("attestation.warning.raised")[0]!.payload.cycle_id, r.cycle_id);
  assert.equal((await b.run("attestation.warning.check", { as_of: "2027-02-01" }) as { cycles: { raised: boolean }[] }).cycles[0]!.raised, false); assert.equal(b.rt.escalations.opened.length, 1);
  assert.equal(b.ctx.timers.byCode("REGAB_1122_ASSESSMENT_PSA_DUE")[0]!.status, "armed");   // the warning is not the breach: the deadline still runs to 2027-03-01
  // the registry rows keep their computed anchors and severities after the per-process overrides (every override re-derives anchorField)
  const reg = loadOverriddenRegistry();
  assert.equal(reg.get("REGAB_1122_ASSESSMENT_PSA_DUE")!.anchorField, "psa_assessment_due"); assert.equal(reg.get("REGAB_1123_STATEMENT_PSA_DUE")!.anchorField, "psa_statement_due"); assert.equal(reg.get("REGAB_1122_2VII_RECON_ITEMS_90")!.anchorField, "item_date");
  for (const code of ["SM_ATTEST_EVIDENCE_COMPILE_FYE_15", "SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45", "SM_SOC1_TYPE2_ANNUAL"]) { assert.equal(reg.get(code)!.anchorField, "fye", code); assert.equal(reg.get(code)!.triggerPattern!.type, "attestation.cycle.opened", code); }
  assert.deepEqual(reg.get("REGAB_1122_ASSESSMENT_PSA_DUE")!.severity, { level: 1, escalateTo: ["officer"] }); assert.equal(reg.get("SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45")!.severity.level, 1);
});
test("18.6-T3: Given a sev-1 QC finding tagged `1122.d.4.x` (escrow refund late on 40 loans), then it appears in the exceptions list and cannot be removed without an officer disposition.", async () => {
  const finding = { id: "QCF-2026-118", severity: "sev1", taxonomy_nodes: ["escrow.refund.late", "regab.1122.d.4.x"], description: "escrow refund later than 30 calendar days of full repayment on 40 loans" };
  const untagged = { id: "QCF-2026-119", severity: "sev2", taxonomy_nodes: ["comms.letter.typo"], description: "cosmetic letter defect" };
  const list = exceptionList({ findings: [finding, untagged] });
  // guardrail: every 18.1 finding tagged to a criterion appears in the exception list — and only those
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { finding_id: "QCF-2026-118", criterion: "1122.d.4.x", severity: "sev1", description: finding.description, status: "open", officer_disposition: null });
  // the agent cannot remove it: no disposition, or a disposition without rationale, is refused
  const agent = removeException({ exception: list[0]!, officer_disposition: null });
  assert.equal(agent.removed, false); assert.match(agent.refusal!, /QCF-2026-118 \(1122\.d\.4\.x\) stays on the list until an officer disposition/);
  assert.equal(removeException({ exception: list[0]!, officer_disposition: { officer_id: "officer-7", rationale: "" } }).removed, false);
  // an officer disposition with rationale releases it, and the list keeps the dispositioned row (append-only, never omitted)
  assert.deepEqual(removeException({ exception: list[0]!, officer_disposition: { officer_id: "officer-7", rationale: "remediated under CAPA-2026-31; not a material instance per auditor materiality framework" } }), { removed: true, refusal: null });
  const after = exceptionList({ findings: [finding], dispositions: [{ finding_id: "QCF-2026-118", officer_id: "officer-7", disposition: "remediated; immaterial" }] });
  assert.equal(after.length, 1); assert.equal(after[0]!.status, "dispositioned"); assert.deepEqual(after[0]!.officer_disposition, { officer_id: "officer-7", disposition: "remediated; immaterial" });
  // the merged list (18.1 findings + timer breaches) carries the same row; a package cannot reach `exceptions_evaluated` while it is open
  const merged = controlExceptions({ findings: [finding, untagged] }); assert.deepEqual(merged, list);
  const blocked = packageTransition({ package_id: "PKG-1122-2026", kind: "regab_1122_assessment", from: "testing", to: "exceptions_evaluated", actor: { kind: "agent" }, open_exceptions: merged.filter((x) => x.status === "open").length });
  assert.equal(blocked.allowed, false); assert.equal(blocked.refusal!.code, "REGAB_EXCEPTIONS_OPEN");
  assert.equal(packageTransition({ package_id: "PKG-1122-2026", kind: "regab_1122_assessment", from: "testing", to: "exceptions_evaluated", actor: { kind: "agent" }, open_exceptions: 0 }).allowed, true);
  // the register is the union of tagged qc_findings rows and recorded rows: a finding nobody "recorded" is on it; a recorded disposition closes it; a recorded timer breach sits beside it
  const breach: ControlException = { finding_id: "TB-REGAB_1122_2VII_RECON_ITEMS_90-RI-1", criterion: "1122.d.2.vii", severity: "sev2", description: "aged 91 days", status: "open", officer_disposition: null };
  const reg0 = exceptionRegister({ findings: [finding, untagged], recorded: [breach] });
  assert.deepEqual(reg0.open.map((x) => x.finding_id), ["QCF-2026-118", "TB-REGAB_1122_2VII_RECON_ITEMS_90-RI-1"]);
  const reg1 = exceptionRegister({ findings: [finding, untagged], recorded: [breach, { ...list[0]!, status: "dispositioned", officer_disposition: { officer_id: "officer-7", disposition: "remediated; immaterial" } }] });
  assert.deepEqual(reg1.open.map((x) => x.finding_id), ["TB-REGAB_1122_2VII_RECON_ITEMS_90-RI-1"]); assert.equal(reg1.register.find((x) => x.finding_id === "QCF-2026-118")!.status, "dispositioned");
  // through the bus: the 18.1 finding lands in `qc_findings`; the package is in `testing`; `exceptions_evaluated` is refused on the register alone — a caller's `open_exceptions: 0` changes nothing — until the officer dispositions the finding
  const b = bus18_6("2026-12-31T22:00:00.000Z"); const { cycle_id, pkg } = await openAbsCycle(b);
  b.clock.set("2027-01-10T15:00:00.000Z"); await compileEvidence(b, pkg);
  for (const to of ["evidence_compiled", "walkthroughs", "testing"]) assert.equal((await b.run("attestation_package.transition", { package_id: pkg, cycle_id, to }) as PackageTransitionResult).allowed, true, to);
  b.rt.store.put("qc_findings", finding.id, { ...finding, status: "validated" }, OFFICER, b.clock.now()); b.rt.store.put("qc_findings", untagged.id, untagged, OFFICER, b.clock.now());
  const onList = await b.run("control_exceptions.list", { package_id: pkg }) as { register: ControlException[]; open: number; open_ids: string[] };
  assert.deepEqual(onList.open_ids, ["QCF-2026-118"]); assert.equal(onList.register[0]!.criterion, "1122.d.4.x"); assert.equal(onList.register[0]!.severity, "sev1");
  const refused = await b.run("attestation_package.transition", { package_id: pkg, cycle_id, to: "exceptions_evaluated", open_exceptions: 0 }) as PackageTransitionResult & { open_exceptions?: string[] };
  assert.equal(refused.allowed, false); assert.equal(refused.refusal!.code, "REGAB_EXCEPTIONS_OPEN"); assert.deepEqual(refused.open_exceptions, ["QCF-2026-118"]); assert.equal(b.rt.store.get("attestation_packages", pkg)!.data.status, "testing");
  await assert.rejects(b.run("exception.disposition", { exception_id: finding.id, officer_id: "officer-7", rationale: "remediated" }), (e: unknown) => e instanceof CommandRefused && e.code === "REGAB_EXCEPTION_OFFICER_DISPOSITION");
  await assert.rejects(b.run("exception.disposition", { exception_id: untagged.id, officer_id: "officer-7", rationale: "cosmetic" }, OFFICER), (e: unknown) => e instanceof RangeError && /QCF-2026-119 is not on the exception register/.test((e as Error).message));
  // one register for every package: the finding is on the SOC 1 package's list too (a `package_id` never narrows the list — an omission by scoping is impossible), and it blocks that package the same way
  const soc1Pkg = `${cycle_id}:soc1_type2`;
  assert.deepEqual((await b.run("control_exceptions.list", { package_id: soc1Pkg }) as { open_ids: string[] }).open_ids, ["QCF-2026-118"]);
  assert.deepEqual((await b.run("control_exceptions.list", { package_id: "PKG-ELSEWHERE" }) as { open_ids: string[]; scope: string }).open_ids, ["QCF-2026-118"]);
  for (const to of ["evidence_compiled", "walkthroughs", "testing"]) assert.equal((await b.run("attestation_package.transition", { package_id: soc1Pkg, cycle_id, to }) as PackageTransitionResult).allowed, true, to);   // the binder on file for the period serves every package of the cycle
  assert.equal((await b.run("attestation_package.transition", { package_id: soc1Pkg, cycle_id, to: "exceptions_evaluated" }) as PackageTransitionResult).refusal!.code, "REGAB_EXCEPTIONS_OPEN");
  const d = await b.run("exception.disposition", { exception_id: finding.id, officer_id: "officer-7", rationale: "remediated under CAPA-2026-31; not a material instance per auditor materiality framework", package_id: pkg }, OFFICER) as { dispositioned: boolean; exception: ControlException };
  assert.equal(d.dispositioned, true); assert.equal(d.exception.criterion, "1122.d.4.x"); assert.equal(d.exception.status, "dispositioned");
  assert.equal((await b.run("control_exceptions.list", { package_id: pkg }) as { open: number }).open, 0);
  assert.equal((await b.run("attestation_package.transition", { package_id: pkg, cycle_id, to: "exceptions_evaluated" }) as PackageTransitionResult).allowed, true);
  // the officer's disposition is of the exception itself: recorded while working the 1122 package, it holds for the SOC 1 (and 1123) package of the same cycle — no package is ever stuck behind a disposition given "for" another
  assert.equal((await b.run("control_exceptions.list", { package_id: soc1Pkg }) as { open: number }).open, 0);
  assert.equal((await b.run("attestation_package.transition", { package_id: soc1Pkg, cycle_id, to: "exceptions_evaluated" }) as PackageTransitionResult).allowed, true);
  assert.equal(b.rt.store.get(EXCEPTIONS, finding.id)!.data.status, "dispositioned"); assert.equal(b.rt.store.get(EXCEPTIONS, finding.id)!.data.package_id, undefined);
});
test("18.6-T4: Given a custodial reconciling item aged 91 days, then a control exception is recorded for (2)(vii).", async () => {
  // rule: item date 2026-10-01 + 90 calendar days = 2026-12-30; as of 2026-12-31 the item is aged 91 days → breached → exception for 1122.d.2.vii
  const x = reconItemControlException({ item_id: "RI-2026-10-01-7", account_id: "CUST-PI-ABS", item_date: D("2026-10-01"), as_of: D("2026-12-31") });
  assert.equal(x.aged_days, 91); assert.equal(x.due, D("2026-12-30")); assert.equal(x.breached, true); assert.deepEqual(x.timer, { code: "REGAB_1122_2VII_RECON_ITEMS_90", status: "breached" });
  assert.equal(x.exception!.criterion, "1122.d.2.vii"); assert.equal(x.exception!.severity, "sev2"); assert.equal(x.exception!.status, "open"); assert.equal(x.exception!.officer_disposition, null);
  assert.equal(x.exception!.finding_id, "TB-REGAB_1122_2VII_RECON_ITEMS_90-RI-2026-10-01-7"); assert.match(x.exception!.description, /aged 91 calendar days \(> 90\).*229\.1122\(d\)\(2\)\(vii\)/);
  // day 90 is still inside the window; resolved on day 90 satisfies; resolved on day 96 satisfies late and still leaves the exception
  const day90 = reconItemControlException({ item_id: "RI-2026-10-01-7", item_date: D("2026-10-01"), as_of: D("2026-12-30") });
  assert.equal(day90.aged_days, 90); assert.equal(day90.breached, false); assert.equal(day90.exception, null); assert.equal(day90.timer.status, "armed");
  assert.equal(reconItemControlException({ item_id: "RI-2026-10-01-7", item_date: D("2026-10-01"), as_of: D("2027-01-15"), resolved_on: D("2026-12-30"), resolved_status: "cleared" }).timer.status, "satisfied");
  const late = reconItemControlException({ item_id: "RI-2026-10-01-7", item_date: D("2026-10-01"), as_of: D("2027-01-15"), resolved_on: D("2027-01-05"), resolved_status: "funded" });
  assert.equal(late.timer.status, "satisfied_late"); assert.equal(late.aged_days, 96); assert.equal(late.exception!.criterion, "1122.d.2.vii");
  // the Reg AB view of a §6.3 item: first_seen_on is the item date, the account's program decides applicability
  const view = classifyReconItem({ source_event_id: "e-63", item_id: "stmt-CUST-PI-ABS-2026-10-01", account_id: "CUST-PI-ABS", first_seen_on: D("2026-10-01"), event_date: D("2026-10-02"), program: { id: "P-ABS", regab_applicable: true } });
  assert.equal(view.type, "regab.reconciling_item.opened"); assert.deepEqual([view.payload.item_date, view.payload.regab_applicable, view.payload.program_id], ["2026-10-01", true, "P-ABS"]);
  // the Reg AB view is keyed to the item, never to the account: the engine satisfies every open clock on the satisfying event's subject, so an account-keyed clock would let one item's resolution satisfy every other item's clock on the account
  assert.deepEqual(view.aggregate, { kind: RECON_ITEM_SUBJECT, id: "stmt-CUST-PI-ABS-2026-10-01" });
  const resolvedView = reconItemResolvedView({ source_event_id: "e-64", item_id: "stmt-CUST-PI-ABS-2026-10-01", account_id: "CUST-PI-ABS", status: "cleared", tracked: true })!;
  assert.equal(resolvedView.type, "regab.reconciling_item.resolved"); assert.deepEqual(resolvedView.aggregate, view.aggregate); assert.equal(resolvedView.payload.status, "cleared");
  assert.equal(reconItemResolvedView({ source_event_id: "e-65", item_id: "stmt-CUST-PI-FNMA-2026-10-01", account_id: "CUST-PI-FNMA", status: "cleared", tracked: false }), null);   // a Fannie Mae item's resolution is no Reg AB event
  // through the timer engine: §6.3's own `reconciliation_item.opened` (bank.read_statement payload, custodial-account aggregate) on the ABS account → the reactor's Reg AB view arms REGAB_1122_2VII_RECON_ITEMS_90 (item date + 90 = 2026-12-30) on the item's own subject
  const b = bus18_6("2026-10-01T15:00:00.000Z"); const { cycle_id } = await openAbsCycle(b);
  b.ctx.events.append({ type: "reconciliation_item.opened", aggregate: { kind: "custodial_account", id: "CUST-PI-ABS" }, actor: SYSTEM, payload: STMT_ITEM });
  const view63 = b.ctx.events.ofType("regab.reconciling_item.opened")[0]!;
  assert.deepEqual(view63.aggregate, { kind: RECON_ITEM_SUBJECT, id: STMT_ITEM.file_id }); assert.equal(view63.payload.regab_applicable, true); assert.equal(view63.payload.item_date, "2026-10-01"); assert.equal(view63.payload.item_id, STMT_ITEM.file_id); assert.equal(view63.payload.program_id, "P-ABS"); assert.equal(view63.payload.account_id, "CUST-PI-ABS");
  const inst = b.ctx.timers.byCode("REGAB_1122_2VII_RECON_ITEMS_90"); assert.equal(inst.length, 1); assert.equal(inst[0]!.anchorDate, "2026-10-01"); assert.equal(inst[0]!.dueDate, "2026-12-30"); assert.deepEqual(inst[0]!.subject, { kind: RECON_ITEM_SUBJECT, id: STMT_ITEM.file_id });
  // a second item B on the *same* account (first seen 2026-11-15, due 2027-02-13) runs its own clock; §6.3 resolves B (`reconciliation_item.resolved` on the account aggregate) — B's clock is satisfied, A's is untouched
  const ITEM_B = { ...STMT_ITEM, file_id: "stmt-CUST-PI-ABS-2026-11-15", first_seen_on: "2026-11-15" };
  b.clock.set("2026-11-16T15:00:00.000Z");
  b.ctx.events.append({ type: "reconciliation_item.opened", aggregate: { kind: "custodial_account", id: "CUST-PI-ABS" }, actor: SYSTEM, payload: ITEM_B });
  const clocks = b.ctx.timers.byCode("REGAB_1122_2VII_RECON_ITEMS_90"); assert.equal(clocks.length, 2); assert.deepEqual(clocks[1]!.subject, { kind: RECON_ITEM_SUBJECT, id: ITEM_B.file_id }); assert.equal(clocks[1]!.dueDate, "2027-02-13");
  b.clock.set("2026-12-01T15:00:00.000Z");
  b.ctx.events.append({ type: "reconciliation_item.resolved", aggregate: { kind: "custodial_account", id: "CUST-PI-ABS" }, actor: SYSTEM, payload: { item_id: ITEM_B.file_id, status: "cleared", root_cause: "timing", evidence_refs: ["bank-2026-12-01"] } });
  const derivedResolved = b.ctx.events.ofType("regab.reconciling_item.resolved"); assert.equal(derivedResolved.length, 1); assert.deepEqual(derivedResolved[0]!.aggregate, { kind: RECON_ITEM_SUBJECT, id: ITEM_B.file_id }); assert.equal(derivedResolved[0]!.payload.status, "cleared"); assert.equal(derivedResolved[0]!.payload.account_id, "CUST-PI-ABS");
  assert.equal(clocks[1]!.status, "satisfied"); assert.equal(clocks[0]!.status, "armed", "resolving item B never satisfies item A's clock");
  assert.deepEqual(b.ctx.timers.evaluate("2026-12-30T12:00:00.000Z"), []);                              // day 90 for A
  assert.equal(b.rt.store.list(EXCEPTIONS).length, 0);
  const breaches = b.ctx.timers.evaluate("2026-12-31T12:00:00.000Z");                                   // day 91 for A: sev-2 → control exception; B is resolved
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.def.code, "REGAB_1122_2VII_RECON_ITEMS_90"); assert.equal(breaches[0]!.severity, 2); assert.match(breaches[0]!.breachText, /control exception/); assert.deepEqual(breaches[0]!.instance.subject, { kind: RECON_ITEM_SUBJECT, id: STMT_ITEM.file_id });
  // the breach itself records the control exception for (2)(vii) — the reactor, not a caller — and it is on the exception list until the officer dispositions it
  const exId = `TB-REGAB_1122_2VII_RECON_ITEMS_90-${STMT_ITEM.file_id}`;
  assert.deepEqual(b.rt.store.list(EXCEPTIONS).map((r) => r.id), [exId]);   // one exception, for A — B's resolution recorded none
  const rec = b.rt.store.get(EXCEPTIONS, exId)!.data as unknown as ControlException & { source: string; timer_code: string; account_id: string; recorded_at: string };
  assert.equal(rec.criterion, "1122.d.2.vii"); assert.equal(rec.severity, "sev2"); assert.equal(rec.status, "open"); assert.equal(rec.source, "timer_breach"); assert.equal(rec.timer_code, "REGAB_1122_2VII_RECON_ITEMS_90"); assert.equal(rec.account_id, "CUST-PI-ABS"); assert.equal(rec.recorded_at, "2026-12-31T12:00:00.000Z");
  assert.match(rec.description, /aged 91 calendar days \(> 90\)/);
  const evt = b.ctx.events.ofType("control.exception.recorded"); assert.equal(evt.length, 1); assert.equal(evt[0]!.payload.criterion, "1122.d.2.vii"); assert.equal(evt[0]!.payload.timer_code, "REGAB_1122_2VII_RECON_ITEMS_90"); assert.equal(evt[0]!.payload.severity, "sev2"); assert.equal(evt[0]!.payload.aged_days, 91);
  assert.deepEqual((await b.run("control_exceptions.list", {}) as { open_ids: string[] }).open_ids, [exId]);
  const listed = controlExceptions({ timer_breaches: [{ timer_code: "REGAB_1122_2VII_RECON_ITEMS_90", subject_id: STMT_ITEM.file_id, criterion: "1122.d.2.vii", description: rec.description }] });
  assert.equal(listed.length, 1); assert.equal(listed[0]!.finding_id, exId); assert.equal(listed[0]!.status, "open");
  // a second evaluation does not duplicate the row (append-only, one exception per breach)
  b.ctx.timers.evaluate("2027-01-02T12:00:00.000Z"); assert.equal(b.rt.store.list(EXCEPTIONS).length, 1);
  // the register is append-only: the agent cannot re-record the reactor's breach — under another package, another description, or at all — so it can neither move off any package's list nor be re-described; the disposition is the only way off the open list
  await assert.rejects(b.run("control_exception.record", { source: "timer_breach", timer_code: "REGAB_1122_2VII_RECON_ITEMS_90", subject_id: STMT_ITEM.file_id, criterion: "1122.d.2.vii", description: "moved", package_id: "PKG-ELSEWHERE" }), (e: unknown) => e instanceof RangeError && /already on the register .*append-only/.test((e as Error).message));
  assert.equal(b.rt.store.history(EXCEPTIONS, exId).length, 1); assert.equal(b.rt.store.get(EXCEPTIONS, exId)!.data.description, rec.description);
  assert.deepEqual((await b.run("control_exceptions.list", { package_id: `${cycle_id}:regab_1122_assessment` }) as { open_ids: string[] }).open_ids, [exId]);
  assert.deepEqual((await b.run("control_exceptions.list", { package_id: "PKG-ELSEWHERE" }) as { open_ids: string[] }).open_ids, [exId]);
  // the agent cannot disposition it (officer act); a disposition for an id that is on no register is refused, never conjured; §6.3's late resolution satisfies the clock late; the officer dispositions with rationale
  b.clock.set("2026-12-31T12:00:00.000Z");
  await assert.rejects(b.run("exception.disposition", { exception_id: exId, officer_id: "officer-7", rationale: "funded 2027-01-05; CAPA-2026-40" }), (e: unknown) => e instanceof CommandRefused && e.code === "REGAB_EXCEPTION_OFFICER_DISPOSITION");
  await assert.rejects(b.run("exception.disposition", { exception_id: "GHOST-1", officer_id: "officer-7", rationale: "n/a" }, OFFICER), (e: unknown) => e instanceof RangeError && /GHOST-1 is not on the exception register/.test((e as Error).message));
  assert.equal(b.rt.store.get(EXCEPTIONS, "GHOST-1"), undefined);
  b.ctx.events.append({ type: "reconciliation_item.resolved", aggregate: { kind: "custodial_account", id: "CUST-PI-ABS" }, actor: SYSTEM, occurredAt: "2027-01-05T15:00:00.000Z", payload: { item_id: STMT_ITEM.file_id, status: "funded", root_cause: "deposit in transit", evidence_refs: ["bank-2027-01-05", "gl-2027-01-05"] } });
  assert.equal(b.ctx.timers.byCode("REGAB_1122_2VII_RECON_ITEMS_90")[0]!.status, "satisfied_late"); assert.equal(b.ctx.timers.byCode("REGAB_1122_2VII_RECON_ITEMS_90")[0]!.satisfiedAt, "2027-01-05T15:00:00.000Z");
  assert.equal(b.ctx.events.ofType("regab.reconciling_item.resolved").length, 2);   // A's resolution re-keyed to A's subject (B's was the first)
  await assert.rejects(b.run("exception.disposition", { exception_id: exId, officer_id: "officer-7", rationale: "" }, OFFICER), (e: unknown) => e instanceof CommandRefused && e.code === "REGAB_EXCEPTION_RATIONALE");
  const d = await b.run("exception.disposition", { exception_id: exId, officer_id: "officer-7", rationale: "funded 2027-01-05; CAPA-2026-40; immaterial per auditor materiality framework" }, OFFICER) as { dispositioned: boolean; exception: ControlException };
  assert.equal(d.dispositioned, true); assert.equal(d.exception.status, "dispositioned"); assert.equal(b.rt.store.history(EXCEPTIONS, exId).length, 2);
  assert.equal((await b.run("control_exceptions.list", {}) as { open: number }).open, 0);
  // the explicit record path (a finding, or a breach seen elsewhere) still exists for the agent's exception analysis, keyed the same way
  const manual = await b.run("control_exception.record", { source: "timer_breach", timer_code: "REGAB_1122_2VII_RECON_ITEMS_90", subject_id: "RI-2026-11-02-3", criterion: "1122.d.2.vii", description: "custodial reconciling item RI-2026-11-02-3 aged 92 calendar days (> 90)", cycle_id }) as ControlException;
  assert.equal(manual.finding_id, "TB-REGAB_1122_2VII_RECON_ITEMS_90-RI-2026-11-02-3"); assert.equal(manual.status, "open"); assert.equal(b.ctx.events.ofType("control.exception.recorded").length, 2);
});
test("18.6-T5: Given `control_evidence.generate('2026-07-01','2027-06-30')` for a June issuer year, then evidence spans the window regardless of Supermortgage's December fiscal year.", async () => {
  // rule 18.6-4: a June issuer year runs 2026-07-01..2027-06-30, straddling Supermortgage's 2026-12-31 fiscal year-end
  assert.deepEqual(assessmentPeriod(D("2027-06-30")), { period_start: D("2026-07-01"), period_end: D("2027-06-30"), basis: "issuer_psa_period" });
  const matrix = MATRIX;
  const evidence = [
    { control_code: "CTL-2VII-RECON", occurred_on: D("2026-06-30"), document_id: "recon-2026-06" },   // before the window
    { control_code: "CTL-2VII-RECON", occurred_on: D("2026-07-31"), document_id: "recon-2026-07" },
    { control_code: "CTL-2VII-RECON", occurred_on: D("2026-12-31"), document_id: "recon-2026-12" },   // Supermortgage FYE — inside the issuer year
    { control_code: "CTL-2VII-RECON", occurred_on: D("2027-01-31"), document_id: "recon-2027-01" },   // after Supermortgage FYE — still inside
    { control_code: "CTL-2VII-RECON", occurred_on: D("2027-06-30"), document_id: "recon-2027-06", exception: true },
    { control_code: "CTL-2VII-RECON", occurred_on: D("2027-07-31"), document_id: "recon-2027-07" },   // after the window
    { control_code: "CTL-4X-ESCROW", occurred_on: D("2026-05-01"), document_id: "escrow-analysis-2026" }, // before the window
    { control_code: "CTL-4X-ESCROW", occurred_on: D("2027-03-15"), document_id: "escrow-analysis-2027" },
  ];
  const r = generateControlEvidence({ period_start: D("2026-07-01"), period_end: D("2027-06-30"), matrix, evidence, supermortgage_fye: D("2026-12-31") });
  assert.deepEqual(r.period, { start: D("2026-07-01"), end: D("2027-06-30") }); assert.equal(r.fiscal_year_basis, "issuer_psa_period"); assert.equal(r.supermortgage_fye, D("2026-12-31"));
  assert.deepEqual(r.rows, [
    { control_code: "CTL-2VII-RECON", criterion: "1122.d.2.vii", evidence_document_ids: ["recon-2026-07", "recon-2026-12", "recon-2027-01", "recon-2027-06"], exceptions_count: 1 },
    { control_code: "CTL-4X-ESCROW", criterion: "1122.d.4.x", evidence_document_ids: ["escrow-analysis-2027"], exceptions_count: 0 },
  ]);
  // the same evidence cut on Supermortgage's own fiscal year gives a different binder — the window, not the FYE, governs
  const sm = generateControlEvidence({ period_start: D("2026-01-01"), period_end: D("2026-12-31"), matrix, evidence, supermortgage_fye: D("2026-12-31") });
  assert.deepEqual(sm.rows[0]!.evidence_document_ids, ["recon-2026-06", "recon-2026-07", "recon-2026-12"]); assert.deepEqual(sm.rows[1]!.evidence_document_ids, ["escrow-analysis-2026"]);
  // the binder honours each control's frequency: (2)(vii) is a *monthly* reconciliation — four documents over twelve issuer months is not complete (eight months missing)
  const binder = controlEvidenceBinder({ period_start: D("2026-07-01"), period_end: D("2027-06-30"), matrix, evidence, supermortgage_fye: D("2026-12-31") });
  assert.equal(binder.complete, false); assert.deepEqual(binder.incomplete_controls, ["CTL-2VII-RECON"]);
  assert.equal(binder.rows[0]!.expected_count, 12); assert.deepEqual(binder.rows[0]!.missing_periods, ["2026-08", "2026-09", "2026-10", "2026-11", "2027-02", "2027-03", "2027-04", "2027-05"]);
  assert.deepEqual(binder.rows[1], { control_code: "CTL-4X-ESCROW", criterion: "1122.d.4.x", frequency: "annual", evidence_document_ids: ["escrow-analysis-2027"], exceptions_count: 0, expected_count: 1, missing_periods: [], complete: true });
  const months = ["2026-08", "2026-09", "2026-10", "2026-11", "2027-02", "2027-03", "2027-04", "2027-05"].map((m) => ({ control_code: "CTL-2VII-RECON", occurred_on: D(`${m}-28`), document_id: `recon-${m}` }));
  const full = controlEvidenceBinder({ period_start: D("2026-07-01"), period_end: D("2027-06-30"), matrix, evidence: [...evidence, ...months], supermortgage_fye: D("2026-12-31") });
  assert.equal(full.complete, true); assert.equal(full.rows[0]!.evidence_document_ids.length, 12); assert.equal(full.rows[0]!.exceptions_count, 1);
  // the gate reads `control_evidence` rows for exactly the package period: no binder → not complete; the latest generation per control decides; a row for another window does not count
  const gen = (complete: boolean, at: string, start = D("2026-07-01"), end = D("2027-06-30")) => ({ control_code: "CTL-2VII-RECON", period_start: start, period_end: end, complete, generated_at: at });
  const escrowRow = { control_code: "CTL-4X-ESCROW", period_start: D("2026-07-01"), period_end: D("2027-06-30"), complete: true, generated_at: "2027-07-02T15:00:00.000Z" };
  assert.deepEqual(evidenceCompleteness({ period_start: D("2026-07-01"), period_end: D("2027-06-30"), matrix, evidence: [] }).missing_controls, ["CTL-2VII-RECON", "CTL-4X-ESCROW"]);
  assert.equal(evidenceCompleteness({ period_start: D("2026-07-01"), period_end: D("2027-06-30"), matrix: [], evidence: [escrowRow] }).complete, false);
  assert.deepEqual(evidenceCompleteness({ period_start: D("2026-07-01"), period_end: D("2027-06-30"), matrix, evidence: [gen(false, "2027-07-01T00:00:00.000Z"), escrowRow] }).incomplete_controls, ["CTL-2VII-RECON"]);
  assert.equal(evidenceCompleteness({ period_start: D("2026-07-01"), period_end: D("2027-06-30"), matrix, evidence: [gen(false, "2027-07-01T00:00:00.000Z"), gen(true, "2027-07-02T00:00:00.000Z"), escrowRow] }).complete, true);
  assert.deepEqual(evidenceCompleteness({ period_start: D("2026-07-01"), period_end: D("2027-06-30"), matrix, evidence: [gen(true, "2027-07-02T00:00:00.000Z", D("2026-01-01"), D("2026-12-31")), escrowRow] }).missing_controls, ["CTL-2VII-RECON"]);
  assert.equal(evidenceCompleteness({ period_start: D("2026-07-01"), period_end: D("2027-06-30"), matrix, criteria_scope: ["1122.d.4.x"], evidence: [escrowRow] }).complete, true);   // out-of-scope criteria are not required
  // a binder cites only documents on file, with their hashes (Audit: "evidence binders with hashes"): a document id nobody filed is not evidence
  assert.deepEqual(evidenceDocumentsOnFile([{ document_id: "recon-2026-07" }, { document_id: "ghost-doc" }], [{ id: "recon-2026-07", sha256: "aa" }]), { missing: ["ghost-doc"], sha256: { "recon-2026-07": "aa" } });
  // the tool writes the append-only `control_evidence` rows for the window and emits `control_evidence.generated{complete}` — after the cited documents are on file
  const b = bus18_6("2027-07-02T15:00:00.000Z");
  await assert.rejects(b.run("control_evidence.generate", { period_start: "2026-07-01", period_end: "2027-06-30", supermortgage_fye: "2026-12-31", matrix, evidence: [...evidence, ...months] }), (e: unknown) => e instanceof RangeError && /evidence cites documents not on file: recon-2026-06, recon-2026-07/.test((e as Error).message));
  assert.equal(b.rt.store.list("control_evidence").length, 0);
  fileDocs(b, [...evidence, ...months]);
  const out = await b.run("control_evidence.generate", { period_start: "2026-07-01", period_end: "2027-06-30", supermortgage_fye: "2026-12-31", matrix, evidence: [...evidence, ...months] }) as typeof full & { matrix_source: string; rows: { evidence_document_sha256: string[] }[] };
  assert.equal(out.complete, true); assert.deepEqual(out.period, { start: "2026-07-01", end: "2027-06-30" }); assert.equal(out.supermortgage_fye, "2026-12-31"); assert.equal(out.matrix_source, "inline");
  assert.deepEqual(out.rows[1]!.evidence_document_sha256, ["sha256:escrow-analysis-2027"]);
  assert.equal(b.rt.store.list("control_evidence").length, 2); assert.equal(b.ctx.events.ofType("control_evidence.generated")[0]!.payload.complete, true);
  // an ad-hoc binder never stands in for the matrix on file: with no control_matrix rows the evidence gate has nothing to be complete for — whatever a caller-supplied inline matrix produced — and a package binder refuses an inline matrix outright
  await b.run("investor_program.create", { id: "P-JUNE-0", investor: "June Trust 2026-0", program_kind: "private_abs_registered", psa_assessment_days: 60 });
  const c0 = await b.run("attestation.cycle.open", { entity: "Supermortgage", fye: "2027-06-30", program_id: "P-JUNE-0" }) as { cycle_id: string }; const pkg0 = `${c0.cycle_id}:regab_1122_assessment`;
  await assert.rejects(b.run("control_evidence.generate", { package_id: pkg0, matrix, evidence: [...evidence, ...months] }), (e: unknown) => e instanceof RangeError && /package binder is generated from the control_matrix on file, never from a caller's inline matrix/.test((e as Error).message));
  await assert.rejects(b.run("control_evidence.generate", { package_id: pkg0, evidence: [...evidence, ...months] }), (e: unknown) => e instanceof RangeError && /no control_matrix rows on file/.test((e as Error).message));
  const synth = await b.run("attestation_package.transition", { package_id: pkg0, to: "evidence_compiled", evidence_complete: true }) as PackageTransitionResult;
  assert.equal(synth.allowed, false); assert.equal(synth.refusal!.code, "REGAB_EVIDENCE_INCOMPLETE"); assert.match(synth.refusal!.reason, /no control_matrix rows in scope/);
  assert.equal(b.ctx.timers.byCode("SM_ATTEST_EVIDENCE_COMPILE_FYE_15")[0]!.status, "armed"); assert.equal(b.rt.store.get("attestation_packages", pkg0)!.data.status, "planned");
  // a June-issuer cycle (FYE 2027-06-30) opens packages for 2026-07-01..2027-06-30; `evidence_compiled` is refused from the stores — with no binder for the period, and with an incomplete one, whatever flag the caller sends — and allowed once the binder for that window is complete
  const june = bus18_6("2027-07-02T15:00:00.000Z");
  await june.run("investor_program.create", { id: "P-JUNE", investor: "June Trust 2026-A", program_kind: "private_abs_registered", psa_assessment_days: 60 });
  const c = await june.run("attestation.cycle.open", { entity: "Supermortgage", fye: "2027-06-30", program_id: "P-JUNE" }) as { cycle_id: string; period: { start: string; end: string } };
  assert.deepEqual(c.period, { start: "2026-07-01", end: "2027-06-30" }); const pkg = `${c.cycle_id}:regab_1122_assessment`;
  assert.deepEqual(dueByCode(june.ctx), { REGAB_1122_ASSESSMENT_PSA_DUE: "2027-08-29", REGAB_1123_STATEMENT_PSA_DUE: "2027-08-29", SM_ATTEST_EVIDENCE_COMPILE_FYE_15: "2027-07-15", SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45: "2027-08-14", SM_SOC1_TYPE2_ANNUAL: "2027-09-13" });
  await june.run("control_matrix.upsert", { rows: matrix }); fileDocs(june, [...evidence, ...months, ...fullEvidence("2026-01-01", "2026-12-31")]);
  const none = await june.run("attestation_package.transition", { package_id: pkg, to: "evidence_compiled", evidence_complete: true }) as PackageTransitionResult;
  assert.equal(none.allowed, false); assert.equal(none.refusal!.code, "REGAB_EVIDENCE_INCOMPLETE"); assert.match(none.refusal!.reason, /no evidence row for CTL-2VII-RECON, CTL-4X-ESCROW/);
  await june.run("control_evidence.generate", { package_id: pkg, evidence });   // period from the package: 2026-07-01..2027-06-30, eight months missing
  const partial = await june.run("attestation_package.transition", { package_id: pkg, to: "evidence_compiled", evidence_complete: true }) as PackageTransitionResult;
  assert.equal(partial.refusal!.code, "REGAB_EVIDENCE_INCOMPLETE"); assert.match(partial.refusal!.reason, /incomplete at its frequency: CTL-2VII-RECON/); assert.equal(june.rt.store.get("attestation_packages", pkg)!.data.status, "planned");
  const dec = await june.run("control_evidence.generate", { package_id: pkg, period_start: "2026-01-01", period_end: "2026-12-31", evidence: fullEvidence("2026-01-01", "2026-12-31") }) as typeof full;
  assert.equal(dec.complete, true);   // a complete binder for Supermortgage's December year is not the issuer period's
  assert.equal((await june.run("attestation_package.transition", { package_id: pkg, to: "evidence_compiled" }) as PackageTransitionResult).refusal!.code, "REGAB_EVIDENCE_INCOMPLETE");
  june.clock.set("2027-07-03T15:00:00.000Z");
  await june.run("control_evidence.generate", { package_id: pkg, evidence: [...evidence, ...months] });
  assert.equal((await june.run("attestation_package.transition", { package_id: pkg, to: "evidence_compiled" }) as PackageTransitionResult).allowed, true);
  assert.equal(june.ctx.timers.byCode("SM_ATTEST_EVIDENCE_COMPILE_FYE_15")[0]!.status, "satisfied");
  assert.equal(packageTransition({ package_id: "PKG-SOC1-2027", kind: "soc1_type2", from: "planned", to: "evidence_compiled", actor: { kind: "agent" }, evidence: null }).refusal!.code, "REGAB_EVIDENCE_INCOMPLETE");
  assert.equal(packageTransition({ package_id: "PKG-SOC1-2027", kind: "soc1_type2", from: "planned", to: "evidence_compiled", actor: { kind: "agent" }, evidence: { complete: true, controls: 2, missing_controls: [], incomplete_controls: [] } }).allowed, true);
});
test("18.6-T6: Given a material-noncompliance determination, then the partner is notified within 1 BD and the item is in the assessment text.", async () => {
  const given = { determined_on: D("2026-11-25"), criterion: "1122.d.4.x", description: "escrow refunds later than 30 calendar days of full repayment on 40 loans", counsel_advice_document_id: "doc-counsel-memo-2026-11" };
  // the agent cannot determine materiality — officer act on counsel's advice (rule 18.6-3)
  const agent = materialNoncompliance({ ...given, determined_by_role: "qc-audit" });
  assert.equal(agent.allowed, false); assert.match(agent.refusal!, /determined by the officer on counsel's advice/); assert.equal(agent.partner_notice, null); assert.equal(agent.assessment_text, null);
  // officer determination Wed 2026-11-25 → partner notice due 1 BD later = Fri 2026-11-27 (Thu 2026-11-26 is Thanksgiving)
  const d = materialNoncompliance({ ...given, determined_by_role: "officer" });
  assert.equal(d.allowed, true); assert.deepEqual(d.partner_notice, { code: "SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD", due: D("2026-11-27") }); assert.equal(d.form_10k_disclosure, true);
  assert.match(d.assessment_text!, /Material instance of noncompliance with servicing criterion 1122\.d\.4\.x \(17 CFR 229\.1122\(d\)\): escrow refunds later than 30 calendar days of full repayment on 40 loans/);
  assert.match(d.assessment_text!, /on counsel's advice \(doc-counsel-memo-2026-11\)/);
  // the disclosure arms the 1 BD clock, names the satisfying event, and the item lands in the Item 1122(a) assessment report
  const x = materialNoncomplianceDisclosure({ ...given, determined_by_role: "officer", partner_notified_on: D("2026-11-27") });
  assert.deepEqual(x.timer, { code: "SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD", anchor: D("2026-11-25"), due: D("2026-11-27"), satisfied_by: "partner.notified{reason=material_noncompliance}", status: "satisfied" });
  assert.deepEqual(x.escalations, []);
  const late = materialNoncomplianceDisclosure({ ...given, determined_by_role: "officer", partner_notified_on: D("2026-11-30") });
  assert.equal(late.timer!.status, "breached"); assert.equal(late.escalations[0]!.kind, "officer"); assert.match(late.escalations[0]!.reason, /sev-1/);
  const report = assessmentReport({ entity: "Supermortgage", period_start: D("2026-01-01"), period_end: D("2026-12-31"), criteria_scope: ["1122.d.2.vii", "1122.d.4.x"], material_noncompliance: [x.item!], attestation_firm: "Registered Firm LLP" });
  assert.equal(report.form_10k_disclosure, true); assert.equal(report.complete, true); assert.equal(report.refusal, null);
  assert.match(report.statements.assessment, /the following material instance of noncompliance was identified: criterion 1122\.d\.4\.x — escrow refunds later than 30 calendar days of full repayment on 40 loans \(determined 2026-11-25; involves the servicing of the assets backing the asset-backed securities\)/);
  assert.match(report.statements.responsibility, /responsible for assessing compliance with the servicing criteria applicable to it/);
  assert.match(report.statements.criteria_used, /used the criteria in paragraph \(d\) of Item 1122/);
  assert.match(report.statements.attestation, /registered public accounting firm, Registered Firm LLP, has issued an attestation report/);
  assert.ok(report.text.includes(x.item!.description));
  // the timer registry satisfies the 1 BD clock only by the partner notice the disclosure names
  const t = loadOverriddenRegistry().get("SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD")!;
  assert.equal(t.satisfiedPattern!.type, "partner.notified"); assert.match(t.satisfied, /partner\.notified\{reason=material_noncompliance\}/);
  // without the auditor's report the assessment is not deliverable (Item 1122(a)(4)) and no 10-K disclosure arises without an item
  const clean = assessmentReport({ entity: "Supermortgage", period_start: D("2026-01-01"), period_end: D("2026-12-31"), criteria_scope: ["1122.d.2.vii"], material_noncompliance: [], attestation_firm: null });
  assert.equal(clean.form_10k_disclosure, false); assert.equal(clean.complete, false); assert.match(clean.refusal!, /attestation report/); assert.match(clean.statements.assessment, /no material instance of noncompliance was identified/);
  // through the bus and the timer engine: the agent is refused; the officer's determination arms SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD (due 2026-11-27); only `partner.notified{reason=material_noncompliance}` satisfies it
  const b = bus18_6("2026-11-25T15:00:00.000Z"); const { cycle_id: cycle, pkg } = await openAbsCycle(b);
  await assert.rejects(b.run("material_noncompliance.determine", { cycle_id: cycle, ...given }), (e: unknown) => e instanceof CommandRefused && e.code === "REGAB_MATERIALITY_OFFICER");
  await assert.rejects(b.run("material_noncompliance.determine", { cycle_id: cycle, ...given, counsel_advice_document_id: "" }, OFFICER), (e: unknown) => e instanceof CommandRefused && e.code === "REGAB_MATERIALITY_COUNSEL_ADVICE");
  const det = await b.run("material_noncompliance.determine", { cycle_id: cycle, ...given, package_id: pkg }, OFFICER) as ReturnType<typeof materialNoncomplianceDisclosure>;
  assert.equal(det.allowed, true); assert.equal(det.timer!.due, D("2026-11-27")); assert.equal(det.timer!.status, "armed");
  const armed = b.ctx.timers.byCode("SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD"); assert.equal(armed.length, 1); assert.equal(armed[0]!.anchorDate, "2026-11-25"); assert.equal(armed[0]!.dueDate, "2026-11-27");
  assert.deepEqual((b.rt.store.get("attestation_packages", pkg)!.data.material_noncompliance as unknown[]), [det.item]);
  await assert.rejects(b.run("partner.notify", { cycle_id: cycle, reason: "shortage_over_25k" }), (e: unknown) => e instanceof CommandRefused && e.code === "REGAB_PARTNER_NOTICE_SCOPE");
  b.clock.set("2026-11-27T14:00:00.000Z");
  await b.run("partner.notify", { cycle_id: cycle, reason: "material_noncompliance", criterion: given.criterion, description: given.description });
  assert.equal(armed[0]!.status, "satisfied"); assert.equal(b.ctx.events.ofType("partner.notified")[0]!.payload.reason, "material_noncompliance");
  // the assertion draft the agent renders is built from the package's stored determination — the item is in the text by construction, with no list from the caller and even with an empty one; the renderer never signs
  const draft = await b.run("letter.render", { template: "ATTEST-1122-ASSERT-v1", package_id: pkg, attestation_firm: "Registered Firm LLP" }) as { status: string; text: string; form_10k_disclosure: boolean; items_from_package: number; statements: { assessment: string } };
  assert.equal(draft.status, "draft_unsigned"); assert.equal(draft.form_10k_disclosure, true); assert.equal(draft.items_from_package, 1); assert.ok(draft.text.includes(given.description)); assert.match(draft.statements.assessment, /For the period 2026-01-01 through 2026-12-31, the following material instance of noncompliance was identified: criterion 1122\.d\.4\.x/);
  const emptied = await b.run("letter.render", { template: "ATTEST-1122-ASSERT-v1", package_id: pkg, entity: "Supermortgage", period_start: "2026-01-01", period_end: "2026-12-31", material_noncompliance: [], attestation_firm: "Registered Firm LLP" }) as { form_10k_disclosure: boolean; text: string };
  assert.equal(emptied.form_10k_disclosure, true); assert.ok(emptied.text.includes(given.description));
  await assert.rejects(b.run("letter.render", { template: "ATTEST-1122-ASSERT-v1", entity: "Supermortgage", period_start: "2026-01-01", period_end: "2026-12-31", attestation_firm: "Registered Firm LLP" }), (e: unknown) => e instanceof RangeError && /package_id is required/.test((e as Error).message));
  await assert.rejects(b.run("letter.render", { template: "ATTEST-1122-ASSERT-v1", package_id: pkg, sign: true }), (e: unknown) => e instanceof CommandRefused && e.code === "REGAB_AGENT_NEVER_SIGNS");
  const sub = subCertification({ entity: "Supermortgage", partner_entity: "Partner Bank", period_start: D("2026-01-01"), period_end: D("2026-12-31"), psa_obligations: ["remit collections by the 18th", "monthly reconciliations of ABS accounts"], known_failures: [{ obligation: "escrow refund within 30 days of payoff", nature: given.description, status: "remediated under CAPA-2026-31" }] });
  assert.equal(sub.fulfilled_in_all_material_respects, false); assert.equal(sub.failures_listed, 1); assert.equal(sub.signature_required_from, "officer"); assert.match(sub.text, /in all material respects throughout the reporting period except as follows/);
});
test("18.6-T7: Given the agent attempts to mark a package `assertion_signed` without an officer signature record, then the transition is refused.", async () => {
  const base = { package_id: "PKG-1122-2026", kind: "regab_1122_assessment" as const, from: "exceptions_evaluated" as const, to: "assertion_signed" as const };
  // the agent, with no signature record: refused — and refused even holding one (the agent never signs or asserts)
  const agent = packageTransition({ ...base, actor: { kind: "agent" }, signature: null });
  assert.equal(agent.allowed, false); assert.equal(agent.status, "exceptions_evaluated"); assert.equal(agent.refusal!.code, "REGAB_AGENT_NEVER_SIGNS"); assert.deepEqual(agent.events, []);
  assert.equal(packageTransition({ ...base, actor: { kind: "agent" }, signature: SIGNATURE }).refusal!.code, "REGAB_AGENT_NEVER_SIGNS");
  // the officer without a signature record — or with an empty, non-officer or undocumented one — is refused too; a non-officer human with a record is refused
  assert.deepEqual(officerSignatureRecord(null), { present: false, why: "no officer signature record" });
  assert.equal(packageTransition({ ...base, actor: { kind: "human", role: "officer" }, signature: null }).refusal!.code, "REGAB_ASSERTION_SIGNATURE_RECORD");
  assert.equal(packageTransition({ ...base, actor: { kind: "human", role: "officer" }, signature: { ...SIGNATURE, officer_id: "" } }).refusal!.code, "REGAB_ASSERTION_SIGNATURE_RECORD");
  assert.equal(packageTransition({ ...base, actor: { kind: "human", role: "officer" }, signature: { ...SIGNATURE, signer_role: "ops_analyst" } }).refusal!.code, "REGAB_ASSERTION_SIGNATURE_RECORD");
  assert.equal(packageTransition({ ...base, actor: { kind: "human", role: "officer" }, signature: { ...SIGNATURE, document_id: "" } }).refusal!.code, "REGAB_ASSERTION_SIGNATURE_RECORD");
  assert.equal(packageTransition({ ...base, actor: { kind: "human", role: "ops_analyst" }, signature: SIGNATURE }).refusal!.code, "REGAB_ASSERTION_OFFICER_ONLY");
  // out of order: planned → assertion_signed is not a step of the state machine
  assert.equal(packageTransition({ ...base, from: "planned", actor: { kind: "human", role: "officer" }, signature: SIGNATURE }).refusal!.code, "REGAB_PACKAGE_ORDER");
  // the officer with a signature record: allowed, and the event is the one SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45 is satisfied by
  const ok = packageTransition({ ...base, actor: { kind: "human", role: "officer" }, signature: SIGNATURE });
  assert.equal(ok.allowed, true); assert.equal(ok.status, "assertion_signed");
  assert.deepEqual(ok.events, [{ type: "attestation.package.status_changed", payload: { package_id: "PKG-1122-2026", kind: "regab_1122_assessment", from: "exceptions_evaluated", status: "assertion_signed", signed_by_role: "officer", signed_by_officer_id: "officer-7", management_assertion_document_id: "doc-assert-2026" } }]);
  assert.match(loadOverriddenRegistry().get("SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45")!.satisfied, /status=assertion_signed, signed_by_role=officer/);
  // the accountant's report gate (Item 1122(b)): a document on file of the package's report kind with its hash — a made-up id, another kind, or no hash is refused
  assert.equal(auditorReportCheck({ package_kind: "regab_1122_assessment", report: null }).code, "REGAB_ATTESTATION_REPORT_MISSING");
  assert.equal(auditorReportCheck({ package_kind: "regab_1122_assessment", report: { document_id: "doc-soc1", kind: "attestation_report:soc1_type2", sha256: "ab", firm: "F" } }).code, "REGAB_ATTESTATION_REPORT_KIND");
  assert.equal(auditorReportCheck({ package_kind: "regab_1122_assessment", report: { document_id: "doc-1122", kind: "attestation_report:regab_1122_assessment", sha256: null, firm: "F" } }).code, "REGAB_ATTESTATION_REPORT_HASH");
  assert.equal(auditorReportCheck({ package_kind: "regab_1122_assessment", report: { document_id: "doc-1122", kind: "attestation_report:regab_1122_assessment", sha256: "ab", firm: "F" } }).ok, true);
  // through the bus: the state machine reads the stored status — a caller's `from` cannot skip steps; `evidence_compiled` is refused until the binder is on file whatever flag is sent; then the guardrails refuse the agent (REGAB_AGENT_NEVER_SIGNS) and the officer without a record (REGAB_ASSERTION_SIGNATURE_RECORD); the package does not move
  const b = bus18_6("2026-12-31T22:00:00.000Z"); const { cycle_id, pkg } = await openAbsCycle(b); const c = { cycle_id };
  b.clock.set("2027-01-10T15:00:00.000Z");
  await assert.rejects(b.run("attestation_package.transition", { package_id: pkg, cycle_id: c.cycle_id, from: "attestation_received", to: "delivered", delivered_to: "Partner Bank" }), (e: unknown) => e instanceof RangeError && /from attestation_received is not the package's stored status planned/.test((e as Error).message));
  assert.equal(b.rt.store.get("attestation_packages", pkg)!.data.status, "planned"); assert.equal(b.ctx.timers.byCode("REGAB_1122_ASSESSMENT_PSA_DUE")[0]!.status, "armed"); assert.equal(b.ctx.events.ofType("attestation.package.delivered").length, 0);
  await assert.rejects(b.run("attestation_package.transition", { package_id: "PKG-NOWHERE", to: "evidence_compiled" }), (e: unknown) => e instanceof RangeError && /no attestation_packages PKG-NOWHERE/.test((e as Error).message));
  const noBinder = await b.run("attestation_package.transition", { package_id: pkg, cycle_id: c.cycle_id, to: "evidence_compiled", evidence_complete: true }) as PackageTransitionResult;
  assert.equal(noBinder.allowed, false); assert.equal(noBinder.refusal!.code, "REGAB_EVIDENCE_INCOMPLETE"); assert.equal(b.ctx.timers.byCode("SM_ATTEST_EVIDENCE_COMPILE_FYE_15")[0]!.status, "armed"); assert.equal(b.rt.store.list("control_evidence").length, 0);
  await compileEvidence(b, pkg);
  for (const to of ["evidence_compiled", "walkthroughs", "testing", "exceptions_evaluated"] as const) {
    const r = await b.run("attestation_package.transition", { package_id: pkg, cycle_id: c.cycle_id, to }) as PackageTransitionResult; assert.equal(r.allowed, true, to);
  }
  assert.equal(b.ctx.timers.byCode("SM_ATTEST_EVIDENCE_COMPILE_FYE_15")[0]!.status, "satisfied");
  await assert.rejects(b.run("attestation_package.transition", { package_id: pkg, cycle_id: c.cycle_id, to: "assertion_signed" }), (e: unknown) => e instanceof CommandRefused && e.code === "REGAB_AGENT_NEVER_SIGNS");
  await assert.rejects(b.run("attestation_package.transition", { package_id: pkg, cycle_id: c.cycle_id, to: "assertion_signed", signature: SIGNATURE }), (e: unknown) => e instanceof CommandRefused && e.code === "REGAB_AGENT_NEVER_SIGNS");
  await assert.rejects(b.run("attestation_package.transition", { package_id: pkg, cycle_id: c.cycle_id, to: "assertion_signed" }, OFFICER), (e: unknown) => e instanceof CommandRefused && e.code === "REGAB_ASSERTION_SIGNATURE_RECORD");
  await assert.rejects(b.run("attestation_package.transition", { package_id: pkg, cycle_id: c.cycle_id, to: "assertion_signed", signature: SIGNATURE }, { kind: "human", id: "analyst-1", role: "ops_analyst" }), (e: unknown) => e instanceof CommandRefused && e.code === "REGAB_ASSERTION_OFFICER_ONLY");
  assert.equal(b.ctx.events.ofType("command.refused").length, 4); assert.equal(b.rt.store.get("attestation_packages", pkg)!.data.status, "exceptions_evaluated");
  assert.equal(b.ctx.timers.byCode("SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45")[0]!.status, "armed");
  // the officer signs on a record: the package moves, the signature is stored, the FYE + 45 clock is satisfied
  b.clock.set("2027-02-10T15:00:00.000Z");
  const signed = await b.run("attestation_package.transition", { package_id: pkg, cycle_id: c.cycle_id, to: "assertion_signed", signature: SIGNATURE }, OFFICER) as PackageTransitionResult;
  assert.equal(signed.allowed, true); assert.equal(b.ctx.timers.byCode("SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45")[0]!.status, "satisfied");
  const stored = b.rt.store.get("attestation_packages", pkg)!.data; assert.equal(stored.status, "assertion_signed"); assert.equal(stored.signed_by_officer_id, "officer-7"); assert.equal(stored.management_assertion_document_id, "doc-assert-2026");
  // attestation_received needs the accountant's report on file with its hash: a made-up id, a receipt without a hash, and the SOC 1 report for the 1122 package are refused; delivery then satisfies REGAB_1122_ASSESSMENT_PSA_DUE (due 2027-03-01) — the 1123 statement package stays open on its own clock
  const noReport = await b.run("attestation_package.transition", { package_id: pkg, cycle_id: c.cycle_id, to: "attestation_received", auditor_report_document_id: "made-up" }) as PackageTransitionResult; assert.equal(noReport.refusal!.code, "REGAB_ATTESTATION_REPORT_MISSING");
  await assert.rejects(b.run("attestation_report.receive", { cycle_id: c.cycle_id, kind: "regab_1122_assessment", document_id: "doc-attest-report-2026", firm: "Registered Firm LLP", package_id: pkg }), (e: unknown) => e instanceof RangeError && /sha256 is required/.test((e as Error).message));
  b.rt.store.put("documents", "doc-soc1-2026", { id: "doc-soc1-2026", kind: "attestation_report:soc1_type2", sha256: "c0ffee", firm: "Registered Firm LLP" }, SYSTEM, b.clock.now());   // the SOC 1 report on file (its receipt event is exercised on its own bus below — see the kernel note)
  assert.equal((await b.run("attestation_package.transition", { package_id: pkg, cycle_id: c.cycle_id, to: "attestation_received", auditor_report_document_id: "doc-soc1-2026" }) as PackageTransitionResult).refusal!.code, "REGAB_ATTESTATION_REPORT_KIND");
  await b.run("attestation_report.receive", { cycle_id: c.cycle_id, kind: "regab_1122_assessment", document_id: "doc-attest-report-2026", sha256: "9f2a…", firm: "Registered Firm LLP", package_id: pkg });
  assert.deepEqual((await b.run("documents.export", { document_ids: ["doc-attest-report-2026"] }) as { documents: { id: string; sha256: string; kind: string }[] }).documents, [{ id: "doc-attest-report-2026", sha256: "9f2a…", kind: "attestation_report:regab_1122_assessment" }]);
  assert.equal((await b.run("attestation_package.transition", { package_id: pkg, cycle_id: c.cycle_id, to: "attestation_received" }) as PackageTransitionResult).allowed, true);   // the report the receipt attached to the package
  assert.equal(b.rt.store.get("attestation_packages", pkg)!.data.auditor_report_document_id, "doc-attest-report-2026");
  assert.equal(b.ctx.timers.byCode("SM_SOC1_TYPE2_ANNUAL")[0]!.status, "armed");   // the 1122 report is not the SOC 1
  b.clock.set("2027-02-26T15:00:00.000Z");
  assert.equal((await b.run("attestation_package.transition", { package_id: pkg, cycle_id: c.cycle_id, to: "delivered", delivered_to: "Partner Bank" }) as PackageTransitionResult).allowed, true);
  assert.equal(b.ctx.timers.byCode("REGAB_1122_ASSESSMENT_PSA_DUE")[0]!.status, "satisfied"); assert.equal(b.ctx.timers.byCode("REGAB_1123_STATEMENT_PSA_DUE")[0]!.status, "armed");
  assert.equal(b.ctx.events.ofType("attestation.package.delivered")[0]!.payload.kind, "regab_1122_assessment");
  // the SOC 1 report receipt (with its hash, from the named firm) is the event the recurring SM_SOC1_TYPE2_ANNUAL clock (FYE + 75 = 2027-03-16) is satisfied by —
  // `attestation.report.received{soc1}`; the 1122 attestation report (soc1=false) is not. Driven through the engine on the same bus: the FYE-anchored instance is
  // satisfied; the kernel's re-arm of a recurring row (anchored on the receipt, which is not the timer table's FYE anchor) is cancelled by the receipt with the reason on
  // record — the next fiscal year's `attestation.cycle.opened` arms its own FYE-anchored instance (T2: opened 2027-01-05 for FYE 2026-12-31 → due 2027-03-16).
  const soc1 = loadOverriddenRegistry().get("SM_SOC1_TYPE2_ANNUAL")!;
  assert.equal(soc1.kindNorm, "recurring"); assert.equal(b.ctx.timers.byCode("SM_SOC1_TYPE2_ANNUAL")[0]!.dueDate, "2027-03-16");
  assert.equal(eventMatches(soc1.satisfiedPattern!, b.ctx.events.ofType("attestation.report.received")[0]!), false);   // the 1122 report already received is not the SOC 1
  b.clock.set("2027-03-10T15:00:00.000Z");
  const soc1Receipt = await b.run("attestation_report.receive", { cycle_id: c.cycle_id, kind: "soc1_type2", document_id: "doc-soc1-2026", sha256: "c0ffee", firm: "Registered Firm LLP", package_id: `${c.cycle_id}:soc1_type2` }) as { soc1: boolean; event_id: string; recurrence_re_arm_cancelled: string[] };
  assert.equal(soc1Receipt.soc1, true); assert.equal(eventMatches(soc1.satisfiedPattern!, b.ctx.events.ofType("attestation.report.received")[1]!), true);
  const soc1Clocks = b.ctx.timers.byCode("SM_SOC1_TYPE2_ANNUAL"); assert.equal(soc1Clocks.length, 2);
  assert.equal(soc1Clocks[0]!.status, "satisfied"); assert.equal(soc1Clocks[0]!.satisfiedAt, "2027-03-10T15:00:00.000Z"); assert.equal(soc1Clocks[0]!.satisfiedByEventId, soc1Receipt.event_id);
  assert.equal(soc1Clocks[1]!.status, "cancelled"); assert.deepEqual(soc1Receipt.recurrence_re_arm_cancelled, [soc1Clocks[1]!.id]); assert.match(soc1Clocks[1]!.cancelledReason!, /next fiscal year's attestation.cycle.opened arms its own FYE-anchored instance/);
  assert.equal(b.ctx.events.ofType("timer.satisfied").filter((e) => e.payload.code === "SM_SOC1_TYPE2_ANNUAL").length, 1);
  assert.deepEqual(b.ctx.timers.evaluate("2027-06-30T12:00:00.000Z").map((x) => x.def.code), ["REGAB_1123_STATEMENT_PSA_DUE"]);   // no SOC 1 breach after FYE + 75 — only the 1123 statement, still undelivered on this bus, is overdue
  assert.equal(b.rt.store.get("attestation_packages", `${c.cycle_id}:soc1_type2`)!.data.auditor_report_document_id, "doc-soc1-2026");
});

test("18.6 tools: the attestation surface is defined for qc-audit, refuses an empty input with a typed reason (never a TypeError), and the bus slice is exactly the registry's 18.6 names", async () => {
  const names = ATTESTATION_TOOLS_18_6.map((t) => t.name);
  assert.equal(new Set(names).size, names.length); assert.ok(ATTESTATION_TOOLS_18_6.every((t) => t.process === "18.6" && t.agent === "qc-audit"));
  for (const n of ["control_evidence.generate", "escalations.create", "qc_results.query", "timers.history", "documents.export", "letter.render", "attestation_package.transition", "material_noncompliance.determine", "partner.notify", "attestation_report.receive", "investor_program.create", "attestation.cycle.open", "control_matrix.upsert", "control_exceptions.list", "control_exception.record", "exception.disposition", "attestation.warning.check"]) assert.ok(names.includes(n), n);
  const specNames = new Set(loadAgentsFile().processes.find((p) => p.process === "18.6")!.tools);
  assert.deepEqual(TOOLS_18_6.map((t) => t.name).sort(), names.filter((n) => specNames.has(n)).sort());
  const b = bus18_6("2026-12-31T22:00:00.000Z");
  for (const t of ATTESTATION_TOOLS_18_6) {
    try { await b.run(t.name, {}); }
    catch (e) { assert.ok(e instanceof RangeError || e instanceof CommandRefused, `${t.name}: ${(e as Error).stack}`); }
  }
});
