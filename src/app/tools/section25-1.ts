/**
 * §25.1 process-owned tools — bus tools for 25.1 defined with `defineTools("25.1", "compliance-tester", defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 25.1; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The `compliance-tester` profile (spec "AI agent design"): computeApr, classifyFinanceCharges, runToleranceTest (21.5),
 * determineQm / determineHpml / determineHoepa (23.4's determinations re-executed with checkpoint figures),
 * evaluateStateHighCost, checkLicenses (op=check|record), checkEsignConsent, checkTcpaConsent, reviewPricingException,
 * checkRespa8, assertGateOpen (op=assert|evaluate|waive|history), openEscalation, writeDecision. Guardrails encode the
 * paragraph: the agent may never (i) waive a legal test, (ii) change a rule-set version, threshold or APOR value,
 * (iii) reclassify a fee to make a test pass without a cited basis, (iv) mark discretionary=false on a deviation that
 * has no reason code, (v) suppress a state test by editing jurisdiction_rules; there is no "force gate open".
 * State lives in the entity store (`compliance_test_runs`, `compliance_tests`, `apr_calculations`,
 * `finance_charge_classifications`, `license_checks`, `pricing_exception_reviews`, `compliance_waivers`); events go
 * through ops-25-1.ts so the 25.1 gates and clocks arm and close.
 */
import { defineTools, compute, escalate, decision, never, needsRole, service, str, num, flag, cents, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { ToolRuntime } from "../tools.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { computeApr, classifyFinanceCharges, determineQm, determineHpml, determineHoepa, evaluateStateHighCost, checkLicenses, recordLicenseCheck, esignConsentTest, tcpaConsentTest, reviewPricingException, checkRespa8, assertGateOpen, evaluateComplianceGate, requestWaiver, complianceHistoryFromEvents, gateCode, aporAsOf, PRICING_REASON_CODES, testDefinition,
  type AprMethod, type Checkpoint, type FeeItemInput, type FeeBenchmark, type AporTable, type LicenseCheck, type EsignConsent, type TcpaConsent, type ComplianceSnapshot, type ComplianceWaiver, type ComplianceTestRow, type ComplianceRun, type GateEvaluation } from "../../domain/compliance-disclosures/ops-25-1.ts";

/** Missing-input refusals are RangeErrors (never TypeErrors) — src/app/tools.test.ts executes every tool with `{}`. */
const need = (i: ToolInput, ...keys: string[]): void => { const missing = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (missing.length) throw new RangeError(`25.1 tool needs ${missing.join(", ")}`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const a = (i.application_id as string | undefined) ?? ctx.applicationId; if (!a) throw new RangeError("25.1 tool needs application_id (every 25.1 event carries it so the gates arm under origination context)"); return a; };
const dateIn = (i: ToolInput, k: string): PlainDate => D(str(i, k));
const asOf = (i: ToolInput, ctx: CommandContext): PlainDate => (i.as_of ? dateIn(i, "as_of") : D(ctx.now.slice(0, 10)));
const bigints = <T extends object>(o: T, keys: readonly string[]): T => { const out: Record<string, unknown> = { ...(o as Record<string, unknown>) }; for (const k of keys) if (out[k] !== undefined && out[k] !== null && typeof out[k] !== "bigint") out[k] = BigInt(String(out[k])); return out as unknown as T; };
const feeItems = (i: ToolInput, k = "items"): FeeItemInput[] => { const xs = i[k]; if (!Array.isArray(xs)) throw new RangeError(`25.1 tool needs ${k}[] (fee_items)`); return (xs as FeeItemInput[]).map((x) => bigints(x, ["amount_cents"])); };
const benchmarks = (i: ToolInput): FeeBenchmark[] => (Array.isArray(i.benchmarks) ? (i.benchmarks as FeeBenchmark[]).map((b) => bigints(b, ["low_cents", "high_cents"])) : []);
const snapshotOf = (i: ToolInput, ctx: CommandContext): ComplianceSnapshot => { const s = i.snapshot as ComplianceSnapshot | undefined; if (!s || typeof s !== "object") throw new RangeError("25.1 tool needs snapshot (the canonical input snapshot for the checkpoint)"); return { ...s, application_id: s.application_id ?? appOf(i, ctx) }; };
const waiversOf = (rt: ToolRuntime, application_id: string): ComplianceWaiver[] => rt.store.list("compliance_waivers", (d) => d.application_id === application_id).map((r) => r.data as unknown as ComplianceWaiver);
const persistRun = (rt: ToolRuntime, ctx: CommandContext, r: GateEvaluation): void => {
  rt.store.put("compliance_test_runs", r.run.run_id, { ...(r.run as unknown as Record<string, unknown>), tests: undefined, gate: r.gate, gate_open: r.open }, ctx.actor, ctx.now);
  r.run.tests.forEach((t, k) => rt.store.put("compliance_tests", `${r.run.run_id}:${t.test_code}:${k}`, { ...t, run_id: r.run.run_id, application_id: r.run.application_id }, ctx.actor, ctx.now));
};
const legalTest = (code: unknown): boolean => { try { return typeof code === "string" && !testDefinition(code).waivable; } catch { return false; } };
const detInput = (i: ToolInput, ctx: CommandContext) => {
  need(i, "apr", "rate_set_date", "loan_amount_cents", "total_loan_amount_cents", "points_and_fees_cents", "lien_position");
  const tables = Array.isArray(i.apor_tables) ? (i.apor_tables as AporTable[]) : [];
  const apor = (i.apor as AporTable | undefined) ?? aporAsOf(tables, dateIn(i, "rate_set_date"));
  return { apr: str(i, "apr"), apor, rate_set_date: dateIn(i, "rate_set_date"), as_of: asOf(i, ctx), loan_amount_cents: cents(i.loan_amount_cents), total_loan_amount_cents: cents(i.total_loan_amount_cents), points_and_fees_cents: cents(i.points_and_fees_cents), lien_position: str(i, "lien_position") as "first" | "subordinate",
    ...(typeof i.term_months === "number" ? { term_months: i.term_months } : {}), prepayment_penalty: (i.prepayment_penalty as { months: number; max_pct: string } | undefined) ?? null, ...(typeof i.escrow_established === "boolean" ? { escrow_established: i.escrow_established } : {}), ...(typeof i.checkpoint === "string" ? { checkpoint: i.checkpoint as Checkpoint } : {}) };
};
const NO_RULESET_EDIT = (name: string) => never("RULESET_THRESHOLD_APOR_IMMUTABLE", "25.1 guardrails (ii): the agent may never change a rule-set version, threshold or APOR value", (i) => i.rule_set_override !== undefined || i.threshold_override !== undefined || i.apor_override !== undefined || i.apor_value_override !== undefined, `${name} runs over the versioned rule set and the FFIEC table as ingested — a threshold, version or APOR value cannot be overridden by the agent (SM_O61_RULESET_ANNUAL_0101 loads new years; SM_O61_APOR_REFRESH_7 refreshes tables)`);

export const TOOLS_25_1: readonly ToolDef[] = defineTools("25.1", "compliance-tester", [
  { name: "computeApr", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "loan_amount_cents", "note_rate_pct", "term_months", "term_start_date", "first_payment_date", "prepaid_finance_charges_cents", "prepaid_interest_cents");
      const method = (i.method as AprMethod | undefined) ?? "appendix_j_exact";
      if (method !== "appendix_j_exact" && method !== "appendix_j_disregard_17c4") throw new RangeError(`method ${String(i.method)} is not appendix_j_exact | appendix_j_disregard_17c4`);
      const r = computeApr({ loan_amount_cents: cents(i.loan_amount_cents), note_rate_pct: str(i, "note_rate_pct"), term_months: num(i, "term_months"), term_start_date: dateIn(i, "term_start_date"), first_payment_date: dateIn(i, "first_payment_date"), prepaid_finance_charges_cents: cents(i.prepaid_finance_charges_cents), prepaid_interest_cents: cents(i.prepaid_interest_cents), method,
        ...(Array.isArray(i.pi_stream_cents) ? { pi_stream_cents: (i.pi_stream_cents as unknown[]).map(cents) } : {}), ...(Array.isArray(i.mi_stream_cents) ? { mi_stream_cents: (i.mi_stream_cents as unknown[]).map(cents) } : {}), ...(typeof i.checkpoint === "string" ? { checkpoint: i.checkpoint as "cd" } : {}), as_of: asOf(i, ctx) });
      const id = `${appOf(i, ctx)}:${r.checkpoint ?? "adhoc"}:${method}:${ctx.now}`;
      rt.store.put("apr_calculations", id, { ...r, application_id: appOf(i, ctx) }, ctx.actor, ctx.now);
      return { apr_calculation_id: id, ...r }; }),
    guardrails: [NO_RULESET_EDIT("computeApr")] },
  { name: "classifyFinanceCharges", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "items");
      const rows = classifyFinanceCharges(feeItems(i), { as_of: asOf(i, ctx), state: str(i, "state") || "", county: (i.county as string | undefined) ?? null, benchmarks: benchmarks(i) });
      for (const r of rows) rt.store.put("finance_charge_classifications", `${appOf(i, ctx)}:${r.fee_item_id}:${r.rule_set_version}`, { ...r, application_id: appOf(i, ctx) }, ctx.actor, ctx.now);
      return { classifications: rows, prepaid_finance_charges_cents: rows.filter((r) => r.classification === "prepaid_finance_charge").reduce((a, r) => a + r.amount_cents, 0n) }; }),
    guardrails: [never("RECLASSIFY_NEEDS_CITED_BASIS", "25.1 guardrails (iii): the agent may never reclassify a fee to make a test pass without a cited basis", (i) => i.reclassify !== undefined && !i.basis_citation, "a manual reclassification carries basis_citation (§1026.4 paragraph) and rationale — otherwise the table's classification stands")] },
  { name: "runToleranceTest", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "checkpoint"); const application_id = appOf(i, ctx);
      // 21.5 owns tolerance_tests / tolerance_cures / runToleranceTest; 25.1 invokes it in-process and mirrors the result into compliance_tests{test_code=TRID_19E3_TOLERANCE}
      const engine = service<{ runToleranceTest(input: { application_id: string; checkpoint: string; fee_items?: unknown }): { result: string; tolerance_test_id?: string; message?: string } }>(rt, "tolerance-21-5");
      const r = engine.runToleranceTest({ application_id, checkpoint: str(i, "checkpoint"), fee_items: i.items });
      return { test_code: "TRID_19E3_TOLERANCE", delegated_to: "21.5", ...r }; }) },
  { name: "determineQm", kind: "act", handler: compute((i, ctx) => determineQm(detInput(i, ctx))), guardrails: [NO_RULESET_EDIT("determineQm")] },
  { name: "determineHpml", kind: "act", handler: compute((i, ctx) => determineHpml(detInput(i, ctx))), guardrails: [NO_RULESET_EDIT("determineHpml")] },
  { name: "determineHoepa", kind: "act", handler: compute((i, ctx) => determineHoepa(detInput(i, ctx))), guardrails: [NO_RULESET_EDIT("determineHoepa")] },
  { name: "evaluateStateHighCost", kind: "act", handler: compute((i, ctx) => {
      need(i, "state", "apr", "loan_amount_cents", "total_loan_amount_cents", "points_and_fees_state_cents", "lien_position");
      return evaluateStateHighCost({ state: str(i, "state"), as_of: asOf(i, ctx), apr: str(i, "apr"), treasury_yield_pct: (i.treasury_yield_pct as string | undefined) ?? null, hoepa_apr_trigger: (i.hoepa_apr_trigger as boolean | undefined) ?? null, loan_amount_cents: cents(i.loan_amount_cents), total_loan_amount_cents: cents(i.total_loan_amount_cents), points_and_fees_state_cents: cents(i.points_and_fees_state_cents), lien_position: str(i, "lien_position") as "first" | "subordinate", prepayment_penalty: (i.prepayment_penalty as { months: number; max_pct: string } | undefined) ?? null, jurisdiction_high_cost_statute: (i.jurisdiction_high_cost_statute as string | undefined) ?? null }); }),
    guardrails: [never("STATE_TEST_NOT_SUPPRESSIBLE", "25.1 guardrails (v): the agent may never suppress a state test by editing jurisdiction_rules", (i) => i.suppress === true || i.jurisdiction_rules_edit !== undefined || i.force_result !== undefined, "a state row is applied as loaded (31.1 verifies statutes); only officer may accept a non-Fannie-Mae state risk through 23.4, never by suppressing the test"), NO_RULESET_EDIT("evaluateStateHighCost")] },
  { name: "checkLicenses", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "state"); const application_id = appOf(i, ctx);
      if (i.op === "record") {
        need(i, "check");
        const r = recordLicenseCheck(ctx.events, { application_id, loan_id: (i.loan_id as string | undefined) ?? ctx.loanId ?? null }, i.check as LicenseCheck);
        rt.store.put("license_checks", (i.check as LicenseCheck).check_id, { ...(i.check as LicenseCheck), application_id }, ctx.actor, ctx.now);
        return { recorded: (i.check as LicenseCheck).check_id, refresh_due: r.refresh_due, event_id: r.event.id };
      }
      const checks = Array.isArray(i.checks) ? (i.checks as LicenseCheck[]) : rt.store.list("license_checks", (d) => d.state === str(i, "state")).map((r) => r.data as unknown as LicenseCheck);
      return checkLicenses({ state: str(i, "state"), as_of: asOf(i, ctx), checks, requirements: { branch_licensed_state: flag(i, "branch_licensed_state"), third_party_processor_license_required: flag(i, "third_party_processor_license_required"), sm_processor_license: (i.sm_processor_license as LicenseCheck | undefined) ?? null, mlo_fitness_attested: flag(i, "mlo_fitness_attested") } }); }) },
  { name: "checkEsignConsent", kind: "act", handler: compute((i, ctx) => {
      need(i, "delivery_channel", "delivery_at", "disclosure_class");
      return esignConsentTest({ consent: (i.consent as EsignConsent | undefined) ?? null, delivery_channel: str(i, "delivery_channel") as "electronic" | "paper" | "in_person", delivery_at: str(i, "delivery_at"), disclosure_class: str(i, "disclosure_class"), as_of: asOf(i, ctx) }); }) },
  { name: "checkTcpaConsent", kind: "act", handler: compute((i, ctx) => {
      need(i, "number", "purpose");
      return tcpaConsentTest({ consents: Array.isArray(i.consents) ? (i.consents as TcpaConsent[]) : [], number: str(i, "number"), purpose: str(i, "purpose"), marketing: flag(i, "marketing"), dnc_scrubbed_at: i.dnc_scrubbed_at ? dateIn(i, "dnc_scrubbed_at") : null, as_of: asOf(i, ctx), at: str(i, "at") || ctx.now }); }) },
  { name: "reviewPricingException", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "review_id", "deviation_ref", "locked_price", "rate_sheet_price", "reason_code");
      const r = reviewPricingException(ctx.events, { application_id: appOf(i, ctx), review_id: str(i, "review_id"), deviation_ref: str(i, "deviation_ref"), locked_price: str(i, "locked_price"), rate_sheet_price: str(i, "rate_sheet_price"), reason_code: str(i, "reason_code"), discretionary: i.discretionary === undefined ? false : (i.discretionary as boolean), reviewed_by: str(i, "reviewed_by") || `${ctx.actor.kind}:${ctx.actor.id}`, now: ctx.now });
      rt.store.put("pricing_exception_reviews", r.review.review_id, { ...r.review }, ctx.actor, ctx.now);
      return { review: r.review, event_id: r.event.id }; }),
    guardrails: [never("DISCRETIONARY_PRICING_NOT_WRITABLE", "25.1 rule 'Fair-lending pricing exceptions': discretionary = true is not a legal value the agent can write", (i) => i.discretionary === true, "pricing_exception_reviews.discretionary must be false (schema CHECK); a discretionary deviation is repriced to the rate sheet, never recorded"),
      never("REASON_CODE_REQUIRED_FOR_NON_DISCRETIONARY", "25.1 guardrails (iv): the agent may never mark discretionary=false on a deviation that has no reason code", (i) => i.discretionary === false && !PRICING_REASON_CODES.includes(i.reason_code as never), `reason_code must be one of ${PRICING_REASON_CODES.join("/")}`)] },
  { name: "checkRespa8", kind: "act", handler: compute((i, ctx) => {
      need(i, "items", "referral_at");
      return checkRespa8({ as_of: asOf(i, ctx), fee_items: feeItems(i), affiliates: Array.isArray(i.affiliates) ? (i.affiliates as string[]) : [], referral_at: str(i, "referral_at"), afba_disclosures: Array.isArray(i.afba_disclosures) ? (i.afba_disclosures as never[]) : [], service_evidence: Array.isArray(i.service_evidence) ? (i.service_evidence as never[]) : [], msa_providers: Array.isArray(i.msa_providers) ? (i.msa_providers as never[]) : [] }); }) },
  { name: "assertGateOpen", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "gate"); const gate = gateCode(str(i, "gate")); const application_id = appOf(i, ctx);
      if (i.op === "history") return complianceHistoryFromEvents(ctx.events, application_id);
      if (i.op === "waive") {
        need(i, "waiver_id", "test", "rationale");
        const r = requestWaiver(ctx.events, { application_id, loan_id: (i.loan_id as string | undefined) ?? ctx.loanId ?? null, waiver_id: str(i, "waiver_id"), test: i.test as ComplianceTestRow, rationale: str(i, "rationale"), expires_at: (i.expires_at as string | undefined) ?? null }, ctx.actor);
        rt.store.put("compliance_waivers", r.waiver.waiver_id, { ...r.waiver, application_id }, ctx.actor, ctx.now);
        return { waiver: r.waiver, event_id: r.event.id };
      }
      const s = snapshotOf(i, ctx);
      const waivers = waiversOf(rt, application_id);
      const existing = (rt.store.list("compliance_test_runs", (d) => d.application_id === application_id && d.gate === gate && d.status !== "superseded").at(-1)?.data as unknown as ComplianceRun | undefined) ?? null;
      const opts = { now: ctx.now, waivers, escalations: rt.escalations, existing_run: existing && Array.isArray(existing.tests) ? existing : null };
      if (i.op === "evaluate") { const r = evaluateComplianceGate(ctx.events, gate, s, opts); persistRun(rt, ctx, r); return r; }
      const r = assertGateOpen(ctx.events, gate, s, opts);   // throws ComplianceGateBlocked → the checkpoint command is refused
      persistRun(rt, ctx, r);
      return r; }),
    guardrails: [never("NO_FORCE_GATE_OPEN", "25.1 'Human path': there is no \"force gate open\"", (i) => i.force_open === true || i.force === true, "a compliance gate re-derives only from a new run or an officer waiver on a policy test"),
      never("WAIVE_LEGAL_TEST", "25.1 guardrails (i): the agent may never waive a legal test", (i) => i.op === "waive" && legalTest((i.test as { test_code?: unknown } | undefined)?.test_code), "compliance_test_definitions.waivable=false for every legal test (APR, finance charge, QM/HPML/HOEPA, state high-cost, licensing, E-SIGN, TCPA, RESPA §8 AfBA/unearned fees, LO comp, steering) — cure the failure"),
      needsRole("WAIVER_IS_OFFICER_ONLY", "25.1 state machine: only `officer` can attach a compliance_waivers row (policy tests)", (i) => i.op === "waive", ["officer"], "a policy-only waiver is the partner officer's act")] },
  { name: "openEscalation", kind: "act", handler: escalate("officer"), humanRoles: ["officer", "mlo_of_record", "licensed_specialist", "human_agent", "ops_analyst"] },
  { name: "writeDecision", kind: "write", handler: decision() },
]);
