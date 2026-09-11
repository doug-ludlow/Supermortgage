/**
 * §23.4 process-owned tools — bus tools for 23.4 defined with `defineTools("23.4", "compliance-tester", defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 23.4; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The `compliance-tester` profile (spec "AI agent design"): getApor, computeTotalLoanAmount, classifyFeeItems,
 * evaluateBonaFideDiscount, runQmTests (op=qm|stage — the stage run writes the three determination rows and their events),
 * runHpmlTests, runHoepaTests, runStateHighCostTests, assembleAtrEvidence, writeDecision, openEscalation. Deterministic
 * rule execution over the versioned rule sets; the LLM component only explains and flags anomalies. Guardrails encode
 * the paragraph: never mark a fee "bona fide third-party" without payee evidence; never exclude discount points without
 * the undiscounted-rate evidence; never accept a stale APOR at lock/CD; never override a state test to "pass" — only
 * `officer` may accept a non-Fannie-Mae state risk; never treat DU findings as ATR evidence; a rule-set threshold or APOR
 * value is never editable (25.1's guardrail (ii)). State lives in the entity store (`qm_determinations`,
 * `hpml_determinations`, `high_cost_determinations`, `apor_tables`); events go through ops-23-4.ts so the gates arm and close.
 */
import { defineTools, compute, escalate, decision, never, needsRole, str, num, flag, cents, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { selectApor, computeTotalLoanAmount, classifyFeeItems, evaluateBonaFideDiscount, runQmTests, runHpmlTests, runHoepaTests, runStateHighCostTests, runDeterminations, recordDeterminations, proposeFeeRestructure, recordPfCureRequired, assembleAtrEvidence, considerVerifyStatus, decisionRecord23_4, supersede,
  type AporTableRow, type FeeItem23, type PfItem, type Stage, type Lien, type ProductTerms, type ConsiderVerifyFactor, type AtrEvidenceInputs, type StageRunInput, type QmRow, type AporSelection, type Classification23, type TotalLoanAmount } from "../../domain/underwriting/ops-23-4.ts";

/** Missing-input refusals are RangeErrors (never TypeErrors) — src/app/tools.test.ts executes every tool with `{}`. */
const need = (i: ToolInput, ...keys: string[]): void => { const missing = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (missing.length) throw new RangeError(`23.4 tool needs ${missing.join(", ")}`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const a = (i.application_id as string | undefined) ?? ctx.applicationId; if (!a) throw new RangeError("23.4 tool needs application_id (every 23.4 event carries it so the gates arm under origination context)"); return a; };
const dateIn = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const asOf = (i: ToolInput, ctx: CommandContext): PlainDate => (i.as_of ? dateIn(i, "as_of") : D(ctx.now.slice(0, 10)));
const STAGES: readonly Stage[] = ["le", "lock", "cd", "consummation", "post_closing"];
const stageIn = (i: ToolInput): Stage => { const v = str(i, "stage"); if (!(STAGES as readonly string[]).includes(v)) throw new RangeError(`23.4 tool needs stage ∈ {${STAGES.join(", ")}}`); return v as Stage; };
const lienIn = (i: ToolInput): Lien => (str(i, "lien") === "subordinate" ? "subordinate" : "first");
const bigints = <T extends object>(o: T, keys: readonly string[]): T => { const out: Record<string, unknown> = { ...(o as Record<string, unknown>) }; for (const k of keys) if (out[k] !== undefined && out[k] !== null && typeof out[k] !== "bigint") out[k] = BigInt(String(out[k])); return out as unknown as T; };
const listIn = <T extends object>(i: ToolInput, k: string, keys: readonly string[] = []): T[] => { const xs = i[k]; if (!Array.isArray(xs)) throw new RangeError(`23.4 tool needs ${k}[]`); return (xs as T[]).map((x) => bigints(x, keys)); };
const feeItems = (i: ToolInput): FeeItem23[] => listIn<FeeItem23>(i, "fee_items", ["amount_cents", "fha_upfront_equivalent_cents", "ppp_max_cents"]);
const aporTables = (i: ToolInput, rt: ToolRuntime): AporTableRow[] => (Array.isArray(i.apor_tables) ? (i.apor_tables as AporTableRow[]) : rt.store.list("apor_tables").map((r) => r.data as unknown as AporTableRow));
const aporIn = (i: ToolInput, rt: ToolRuntime, stage: Stage, requested_on: PlainDate): AporSelection => {
  if (i.apor && typeof i.apor === "object") return i.apor as AporSelection;
  need(i, "rate_set_date");
  return selectApor(aporTables(i, rt), { rate_set_date: dateIn(i, "rate_set_date"), term_years: i.term_years === undefined ? 30 : num(i, "term_years"), product: str(i, "product") === "adjustable" ? "adjustable" : "fixed", stage, requested_on });
};
const productIn = (i: ToolInput): ProductTerms => { const p = i.product as ProductTerms | undefined; if (!p || typeof p !== "object") throw new RangeError("23.4 tool needs product {term_months, amortization, substantially_equal_payments}"); return p; };
const persist = (rt: ToolRuntime, ctx: CommandContext, kind: string, id: string, data: Record<string, unknown>) => rt.store.put(kind, id, data, ctx.actor, ctx.now);
const NO_RULESET_EDIT = (name: string) => never("RULESET_THRESHOLD_APOR_IMMUTABLE", "25.1 guardrails (ii) / 23.4 'never accept a stale APOR at lock/CD'", (i) => i.rule_set_override !== undefined || i.threshold_override !== undefined || i.apor_override !== undefined || i.apor_value_override !== undefined, `${name} runs over the versioned rule set and the FFIEC table as ingested — thresholds, tier boundaries and APOR values cannot be overridden by the agent`);
const NO_STALE_APOR = (name: string) => never("APOR_STALE_NOT_ACCEPTED", "23.4 guardrails: never accept a stale APOR at lock/CD", (i) => i.accept_stale === true || i.ignore_apor_stale === true, `${name}: a lock/cd-stage determination on an APOR table older than 14 days is blocked (apor_stale) until FFIEC_APOR_TABLE_REFRESH_WEEKLY ingests a newer table — it cannot be accepted by the agent`);

export const TOOLS_23_4: readonly ToolDef[] = defineTools("23.4", "compliance-tester", [
  { name: "getApor", kind: "read", handler: compute((i, ctx, rt) => {
    need(i, "rate_set_date");
    const stage = i.stage ? stageIn(i) : "le";
    const sel = selectApor(aporTables(i, rt), { rate_set_date: dateIn(i, "rate_set_date"), term_years: i.term_years === undefined ? 30 : num(i, "term_years"), product: str(i, "product") === "adjustable" ? "adjustable" : "fixed", stage, requested_on: asOf(i, ctx) });
    return { ...sel, table: sel.table ? { table_id: sel.table.table_id, effective_week: sel.table.effective_week, type: sel.table.type, hash: sel.table.hash } : null };
  }), guardrails: [NO_STALE_APOR("getApor"), NO_RULESET_EDIT("getApor")] },
  { name: "computeTotalLoanAmount", kind: "act", handler: compute((i) => {
    need(i, "loan_amount_cents", "prepaid_finance_charges_cents");
    return computeTotalLoanAmount({ loan_amount_cents: cents(i.loan_amount_cents), prepaid_finance_charges_cents: cents(i.prepaid_finance_charges_cents), pf_items: Array.isArray(i.pf_items) ? listIn<PfItem>(i, "pf_items", ["amount_cents", "included_cents"]) : [] });
  }) },
  { name: "classifyFeeItems", kind: "act", handler: compute((i, ctx) => {
    const items = feeItems(i);
    return classifyFeeItems(items, { as_of: asOf(i, ctx), undiscounted_rate_pct: (i.undiscounted_rate_pct as string | undefined) ?? null, apor_pct: (i.apor_pct as string | undefined) ?? null, ...(i.state ? { state: str(i, "state") } : {}), county: (i.county as string | undefined) ?? null, benchmarks: Array.isArray(i.benchmarks) ? listIn(i, "benchmarks", ["low_cents", "high_cents"]) : [], buydown_evidence_ref: (i.buydown_evidence_ref as string | undefined) ?? null });
  }), guardrails: [
    never("BONA_FIDE_THIRD_PARTY_NEEDS_PAYEE", "23.4 guardrails: never mark a fee \"bona fide third-party\" without payee evidence", (i) => Array.isArray(i.fee_items) && (i.fee_items as Record<string, unknown>[]).some((f) => (f.exclusion === "bona_fide_third_party" || f.bona_fide_third_party === true) && !f.payee && !f.paid_to), "a fee is excluded as a bona fide third-party charge only with the payee (fee_items.paid_to / payee) and its unaffiliated, not-retained status on the record"),
    never("FEE_RECLASSIFY_NEEDS_BASIS", "25.1 guardrails (iii): never reclassify a fee to make a test pass without a cited basis", (i) => i.reclassify !== undefined && !i.basis_citation, "a reclassification carries a cited §1026.4 / §1026.32(b)(1) basis"),
  ] },
  { name: "evaluateBonaFideDiscount", kind: "act", handler: compute((i) => evaluateBonaFideDiscount({ undiscounted_rate_pct: (i.undiscounted_rate_pct as string | undefined) ?? null, apor_pct: (i.apor_pct as string | undefined) ?? null, buydown_evidence_ref: (i.buydown_evidence_ref as string | undefined) ?? null })), guardrails: [
    never("DISCOUNT_EXCLUSION_NEEDS_UNDISCOUNTED_RATE", "23.4 guardrails: never exclude discount points without the undiscounted-rate evidence", (i) => (i.exclude_points !== undefined || i.force_exclude === true) && !i.undiscounted_rate_pct, "the pricing engine's undiscounted rate at the rate-set date (20.4 pricing_quotes) and its buydown table are the evidence for a bona fide discount exclusion (§1026.32(b)(3))"),
    NO_RULESET_EDIT("evaluateBonaFideDiscount"),
  ] },
  { name: "runQmTests", kind: "act", handler: compute((i, ctx, rt) => {
    const application_id = appOf(i, ctx); const stage = stageIn(i); const as_of = asOf(i, ctx);
    if (i.op === "stage") {
      // the whole stage: rate-set date, APOR snapshot, itemization, total loan amount, QM / HPML / HOEPA / state rows, events, gates
      need(i, "apr", "apr_calculation_id", "loan_amount_cents", "state");
      const input: StageRunInput = { application_id, stage, as_of, determined_at: ctx.now, apr_calculation_id: str(i, "apr_calculation_id"), apr: str(i, "apr"), locks: listIn(i, "locks"), apor_tables: aporTables(i, rt), loan_amount_cents: cents(i.loan_amount_cents), fee_items: feeItems(i),
        undiscounted_rate_pct: (i.undiscounted_rate_pct as string | undefined) ?? null, buydown_evidence_ref: (i.buydown_evidence_ref as string | undefined) ?? null, product: productIn(i), consider_verify: Array.isArray(i.consider_verify) ? (i.consider_verify as ConsiderVerifyFactor[]) : [], lien: lienIn(i), manufactured_home: flag(i, "manufactured_home"), principal_dwelling: i.principal_dwelling === undefined ? true : flag(i, "principal_dwelling"),
        state: str(i, "state"), county: (i.county as string | undefined) ?? null, consummation_date: i.consummation_date ? dateIn(i, "consummation_date") : null, escrow_established_before_consummation: typeof i.escrow_established_before_consummation === "boolean" ? (i.escrow_established_before_consummation as boolean) : null, escrow_waiver_elected: flag(i, "escrow_waiver_elected"),
        ...(i.reference_rates && typeof i.reference_rates === "object" ? { reference_rates: i.reference_rates as StageRunInput["reference_rates"] } : {}), computed_from_final_cd: flag(i, "computed_from_final_cd"), agent_decision_id: (i.agent_decision_id as string | undefined) ?? null };
      const r = runDeterminations(input);
      const prior = rt.store.list("qm_determinations", (d) => d.application_id === application_id).map((x) => x.data as unknown as QmRow);
      for (const row of supersede(prior, r.qm)) persist(rt, ctx, "qm_determinations", row.determination_id, row as unknown as Record<string, unknown>);
      persist(rt, ctx, "hpml_determinations", r.hpml.determination_id, r.hpml as unknown as Record<string, unknown>);
      persist(rt, ctx, "high_cost_determinations", r.high_cost.determination_id, r.high_cost as unknown as Record<string, unknown>);
      const events = recordDeterminations(ctx.events, { application_id, loan_id: (i.loan_id as string | undefined) ?? null, actor: ctx.actor, at: ctx.now }, r);
      const extra: Record<string, unknown> = {};
      if (r.qm.qm_type === "not_qm" && (stage === "cd" || stage === "lock" || stage === "le")) extra.restructure = proposeFeeRestructure(ctx.events, { application_id, actor: ctx.actor, at: ctx.now }, r.qm).payload;
      if (r.qm.qm_type === "not_qm" && stage === "post_closing" && r.qm.cure_required_cents !== null && i.consummation_date) extra.cure = recordPfCureRequired(ctx.events, { application_id, loan_id: (i.loan_id as string | undefined) ?? null, actor: ctx.actor, at: ctx.now }, { qm: r.qm, consummation_date: dateIn(i, "consummation_date"), discovered_on: as_of, note_rate_pct: str(i, "note_rate_pct") || "0", escalations: rt.escalations }).event.payload;
      const rec = decisionRecord23_4(r, { model_version: ctx.run?.modelVersion ?? "deterministic", prompt_version: ctx.run?.promptVersion ?? "n/a", rationale: `23.4 ${stage}-stage determinations: qm_type=${r.qm.qm_type}, is_hpml=${r.hpml.is_hpml}, is_hoepa=${r.high_cost.is_hoepa}, fnma_eligible=${r.high_cost.fnma_eligible}` });
      return { qm: r.qm, hpml: r.hpml, high_cost: r.high_cost, apor: r.apor, events: events.map((e) => e.type), decision: rec, ...extra };
    }
    need(i, "apr", "apr_calculation_id", "loan_amount_cents", "rate_set_date");
    const apor = aporIn(i, rt, stage, as_of);
    const fees = (i.fees as Classification23 | undefined) ?? classifyFeeItems(feeItems(i), { as_of, undiscounted_rate_pct: (i.undiscounted_rate_pct as string | undefined) ?? null, apor_pct: apor.apor_pct });
    const total = (i.total as TotalLoanAmount | undefined) ?? computeTotalLoanAmount({ loan_amount_cents: cents(i.loan_amount_cents), prepaid_finance_charges_cents: fees.prepaid_finance_charges_cents, pf_items: fees.items });
    return runQmTests({ application_id, stage, apr_calculation_id: str(i, "apr_calculation_id"), apr: str(i, "apr"), rate_set_date: dateIn(i, "rate_set_date"), apor, loan_amount_cents: cents(i.loan_amount_cents), total, fees, product: productIn(i), consider_verify: Array.isArray(i.consider_verify) ? (i.consider_verify as ConsiderVerifyFactor[]) : [], lien: lienIn(i), manufactured_home: flag(i, "manufactured_home"), as_of, computed_from_final_cd: flag(i, "computed_from_final_cd"), determined_at: ctx.now });
  }), guardrails: [NO_STALE_APOR("runQmTests"), NO_RULESET_EDIT("runQmTests"), never("QM_TYPE_NOT_ASSERTABLE", "23.4 AI agent design: the LLM component never overrides a computed result", (i) => i.qm_type !== undefined || i.force_qm_type !== undefined, "qm_type is computed from the APR, points-and-fees, product and consider-and-verify tests — never asserted")] },
  { name: "runHpmlTests", kind: "act", handler: compute((i, ctx, rt) => {
    const application_id = appOf(i, ctx); const stage = stageIn(i); const as_of = asOf(i, ctx);
    need(i, "apr", "loan_amount_cents", "rate_set_date");
    return runHpmlTests({ application_id, stage, apr: str(i, "apr"), rate_set_date: dateIn(i, "rate_set_date"), apor: aporIn(i, rt, stage, as_of), loan_amount_cents: cents(i.loan_amount_cents), lien: lienIn(i), principal_dwelling: i.principal_dwelling === undefined ? true : flag(i, "principal_dwelling"), qm_type: (i.qm_type as QmRow["qm_type"] | undefined) ?? null, consummation_date: i.consummation_date ? dateIn(i, "consummation_date") : null, escrow_established_before_consummation: typeof i.escrow_established_before_consummation === "boolean" ? (i.escrow_established_before_consummation as boolean) : null, escrow_waiver_elected: flag(i, "escrow_waiver_elected"), flip_check: (i.flip_check as Record<string, unknown> | undefined) ?? null, as_of, determined_at: ctx.now });
  }), guardrails: [NO_STALE_APOR("runHpmlTests"), NO_RULESET_EDIT("runHpmlTests"), never("HPML_ESCROW_NOT_WAIVABLE", "§1026.35(b)(1): an HPML first lien on a principal dwelling is not extended without an escrow account", (i) => i.waive_escrow === true, "the borrower's escrow waiver election on an HPML is refused — 30.3 refuses the waiver and REGZ_1026_35B1_HPML_ESCROW_GATE blocks consummation")] },
  { name: "runHoepaTests", kind: "act", handler: compute((i, ctx, rt) => {
    const stage = i.stage ? stageIn(i) : "cd"; const as_of = asOf(i, ctx);
    need(i, "apr", "loan_amount_cents", "total_loan_amount_cents", "pf_cents", "rate_set_date");
    return runHoepaTests({ apr: str(i, "apr"), rate_set_date: dateIn(i, "rate_set_date"), apor: aporIn(i, rt, stage, as_of), loan_amount_cents: cents(i.loan_amount_cents), total_loan_amount_cents: cents(i.total_loan_amount_cents), pf_cents: cents(i.pf_cents), lien: lienIn(i), personal_property_dwelling_lt_50k: flag(i, "personal_property_dwelling_lt_50k"), prepayment_penalty: (i.prepayment_penalty as { months: number; max_pct: string } | undefined) ?? null, as_of });
  }), guardrails: [NO_RULESET_EDIT("runHoepaTests")] },
  { name: "runStateHighCostTests", kind: "act", handler: compute((i, ctx) => {
    need(i, "state", "loan_amount_cents", "total_loan_amount_cents", "pf_cents", "apr");
    return runStateHighCostTests({ state: str(i, "state"), loan_amount_cents: cents(i.loan_amount_cents), total_loan_amount_cents: cents(i.total_loan_amount_cents), pf_cents: cents(i.pf_cents), apr: str(i, "apr"), lien: lienIn(i), hoepa_apr_fail: typeof i.hoepa_apr_fail === "boolean" ? (i.hoepa_apr_fail as boolean) : null, ...(i.reference_rates && typeof i.reference_rates === "object" ? { reference_rates: i.reference_rates as never } : {}), ...(i.conforming_limit_cents !== undefined ? { conforming_limit_cents: cents(i.conforming_limit_cents) } : {}), as_of: asOf(i, ctx) });
  }), guardrails: [
    never("STATE_TEST_NOT_OVERRIDABLE", "23.4 guardrails: never override a state test to \"pass\"", (i) => i.override_result !== undefined || i.force_pass === true, "a state high-cost result is computed from jurisdiction_rules; only an officer may accept a non-Fannie-Mae state risk (accept_state_risk)"),
    needsRole("STATE_RISK_ACCEPTANCE_OFFICER", "23.4 guardrails: only `officer` may accept a non-Fannie-Mae state risk", (i) => i.accept_state_risk === true, ["officer"], "acceptance of a state high-cost risk that is not a Fannie Mae eligibility bar is partner counsel's decision recorded by an officer"),
    never("JURISDICTION_RULES_NOT_EDITABLE", "25.1 guardrails (v): never suppress a state test by editing jurisdiction_rules", (i) => i.jurisdiction_rules_override !== undefined || i.suppress_state !== undefined, "state definitions come from jurisdiction_rules / the verified statute table — the agent cannot edit or suppress them"),
  ] },
  { name: "assembleAtrEvidence", kind: "act", handler: compute((i) => {
    if (i.op === "status") return considerVerifyStatus(Array.isArray(i.consider_verify) ? (i.consider_verify as ConsiderVerifyFactor[]) : []);
    const inputs = i.inputs as AtrEvidenceInputs | undefined;
    if (!inputs || typeof inputs !== "object") throw new RangeError("23.4 tool needs inputs {income, employment, payment, simultaneous_loans, mortgage_obligations, debts, dti, credit_history} from 22.2/22.3/22.5/25.2/30.3");
    for (const k of ["income", "employment", "payment", "simultaneous_loans", "mortgage_obligations", "debts", "dti", "credit_history"] as const) if (!inputs[k] || typeof inputs[k] !== "object") throw new RangeError(`23.4 assembleAtrEvidence needs inputs.${k}`);
    const fix = <T extends object>(o: T, keys: readonly string[]): T => bigints(o, keys);
    const map = assembleAtrEvidence({ ...inputs, income: fix(inputs.income, ["monthly_cents"]), payment: fix(inputs.payment, ["pi_cents"]), simultaneous_loans: fix(inputs.simultaneous_loans, ["monthly_cents"]), mortgage_obligations: fix(inputs.mortgage_obligations, ["monthly_cents"]), debts: fix(inputs.debts, ["monthly_cents", "alimony_child_support_cents"]) });
    return { consider_verify: map, status: considerVerifyStatus(map) };
  }), guardrails: [never("DU_FINDINGS_NOT_ATR_EVIDENCE", "23.4 guardrails: never treat DU findings as ATR evidence (they are not third-party records)", (i) => JSON.stringify(i.inputs ?? null).includes("\"du_findings\""), "DU findings and messages are not §1026.43(c)(4) third-party records — cite the underlying paystub, W-2, financial-institution or employer record the DU validation service read")] },
  { name: "writeDecision", kind: "write", handler: decision() },
  { name: "openEscalation", kind: "act", handler: escalate("underwriting_reviewer"), humanRoles: ["officer", "underwriting_reviewer", "fnma_portal_operator", "human_agent", "licensed_specialist", "mlo_of_record", "ops_analyst"] },
]);
