/**
 * §23.2 process-owned tools — bus tools for 23.2 defined with `defineTools("23.2", "underwriter", defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 23.2; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The `underwriter` profile (spec "AI agent design"): parseFindings (op=interpret runs rules 1–9 over one
 * `du.findings.received` payload and emits `du.findings.interpreted` inside SM_DU_CONDITIONS_SLA_4H), mapMessages,
 * openCondition, openInvestigation, evaluateHomeReady (AMI API / DU message / web tool only), verifyEducationCertificate
 * (op=receive | verify), computeRestructure, quote (20.4 arithmetic for a proposed structure; the pricing service when
 * wired), proposeRestructure (op=propose | accept | expire), writeDecision, openEscalation. Guardrails encode the paragraph:
 * never drop an unmapped message; never re-word a DU requirement into something weaker; never present DU output to the
 * borrower; never propose a restructure that changes the borrower's stated occupancy or income; never send a counteroffer
 * or denial without `underwriting_reviewer`; never rely on non-Fannie Mae AMI data; never mark education verified without
 * the certificate document. State lives in the entity store (`du_findings_interpretations`, `conditions`,
 * `du_message_rules`, `homeready_evaluations`, `homeownership_education_records`, `restructure_proposals`,
 * `du_message_triage`, `investigations`); events go through ops-23-2.ts so the 23.2 timers arm and close.
 */
import { defineTools, compute, escalate, decision, never, needsRole, str, num, flag, cents, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { interpretFindings, mapMessages, openCondition, openRedFlagInvestigation, closeInvestigation, evaluateHomeReady, recordHomeReadyEvaluation, requireEducation, receiveEducationCertificate, verifyEducationCertificate, computeRestructure, pitiaFor, proposeRestructure, acceptRestructure, expireRestructure, borrowerSafe, loanLimitCheck, miCoverage, sfcAssembly, ctcBlockers, clearUnmappedCondition, decisionRecord23_2, DU_MESSAGE_RULES_2026_09_25, CURRENT_DU_RELEASE, RULE_SETS_23_2,
  type InterpretInput, type ApplicationFacts, type StructureFinancials, type DuMessageRule, type Condition, type Investigation23, type EducationRecord, type RestructureProposal, type Lever, type RedFlag, type ProviderType, type RequirementBasis, type ConditionCategory, type ConditionStage, type InterpretResult } from "../../domain/underwriting/ops-23-2.ts";
import type { DuMessage, ValidationResult, Recommendation, PolicyGeneration } from "../../domain/underwriting/ops-23-1.ts";

/** Missing-input refusals are RangeErrors (never TypeErrors) — src/app/tools.test.ts executes every tool with `{}`. */
const need = (i: ToolInput, ...keys: string[]): void => { const missing = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (missing.length) throw new RangeError(`23.2 tool needs ${missing.join(", ")}`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const a = (i.application_id as string | undefined) ?? ctx.applicationId; if (!a) throw new RangeError("23.2 tool needs application_id (every 23.2 event carries it so the timers arm under origination context)"); return a; };
const dateIn = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] ? dateIn(i, k) : null);
const optStr = (i: ToolInput, k: string): string | null => (typeof i[k] === "string" && (i[k] as string).length ? (i[k] as string) : null);
const list = <T>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const persist = (rt: ToolRuntime, ctx: CommandContext, kind: string, id: string, data: object) => rt.store.put(kind, id, data as Record<string, unknown>, ctx.actor, ctx.now);
const rows = <T>(rt: ToolRuntime, kind: string, where: (d: Record<string, unknown>) => boolean = () => true): T[] => rt.store.list(kind, where).map((r) => r.data as unknown as T);
const rulesOf = (i: ToolInput, rt: ToolRuntime): readonly DuMessageRule[] => { const stored = rows<DuMessageRule>(rt, "du_message_rules"); return Array.isArray(i.rules) ? (i.rules as DuMessageRule[]) : stored.length ? stored : DU_MESSAGE_RULES_2026_09_25; };
const asBig = <T extends object>(o: T, keys: readonly string[]): T => { const out: Record<string, unknown> = { ...(o as Record<string, unknown>) }; for (const k of keys) if (out[k] !== undefined && out[k] !== null && typeof out[k] !== "bigint") out[k] = BigInt(String(out[k])); return out as unknown as T; };
const factsIn = (i: ToolInput): ApplicationFacts => { const f = i.facts as ApplicationFacts | undefined; if (!f || typeof f !== "object") throw new RangeError("23.2 tool needs facts {transaction_type, product, term_months, ltv_x100, loan_amount_cents, units, county_limit_cents, score_model, borrower_ids, all_occupying_first_time, all_borrowers_first_time, du_no_tradelines, closing_date}"); return asBig(f, ["loan_amount_cents", "county_limit_cents"]); };
const financialsIn = (i: ToolInput, k = "financials"): StructureFinancials => { const f = i[k] as StructureFinancials | undefined; if (!f || typeof f !== "object") throw new RangeError(`23.2 tool needs ${k} {monthly_income_cents, loan_amount_cents, value_cents, purchase_price_cents, transaction_type, note_rate_pct, term_months, taxes_monthly_cents, insurance_monthly_cents, other_debts_monthly_cents, mi_annual_rate_pct, product}`); return asBig(f, ["monthly_income_cents", "loan_amount_cents", "value_cents", "purchase_price_cents", "taxes_monthly_cents", "insurance_monthly_cents", "other_debts_monthly_cents", "county_limit_cents"]); };
const PROVIDER_TYPES: readonly ProviderType[] = ["homeview", "hud_approved_agency", "nis_aligned_provider"];
const RED_FLAGS: readonly RedFlag[] = ["frozen_credit", "casefile_id_reuse", "excessive_resubmissions", "occupancy_modified"];
const persistResult = (rt: ToolRuntime, ctx: CommandContext, r: InterpretResult) => {
  persist(rt, ctx, "du_findings_interpretations", r.interpretation.interpretation_id, r.interpretation);
  for (const c of [...r.conditions, ...r.superseded]) persist(rt, ctx, "conditions", c.condition_id, c);
  for (const v of r.investigations) persist(rt, ctx, "investigations", v.investigation_id, v);
  for (const t of r.triage) persist(rt, ctx, "du_message_triage", t.triage_id, t);
  for (const e of r.education) persist(rt, ctx, "homeownership_education_records", e.record_id, e);
  for (const p of r.proposals) persist(rt, ctx, "restructure_proposals", p.proposal_id, p);
};
const idsInStore = (rt: ToolRuntime, application_id: string): string[] => rows<{ du_message_id: string | null }>(rt, "conditions", (d) => d.application_id === application_id).map((c) => c.du_message_id).filter((x): x is string => typeof x === "string");

const NO_DU_TO_BORROWER = (name: string) => never("DU_OUTPUT_TO_BORROWER", "23.2 guardrails: never present DU output to the borrower (Fannie Mae-confidential; the creditor is the partner)", (i) => typeof i.text === "string" && (i.borrower_visible !== false) && !borrowerSafe(i.text as string, [str(i, "du_message_id"), ...list<string>(i, "message_ids")]), `${name}: borrower-facing text is SM-rendered needs-list wording — no DU message id, no "DU"/"Desktop Underwriter", no recommendation wording`);

export const TOOLS_23_2: readonly ToolDef[] = defineTools("23.2", "underwriter", [
  { name: "parseFindings", kind: "act", handler: compute((i, ctx, rt) => {
    const application_id = appOf(i, ctx); need(i, "submission_id", "recommendation"); const messages = list<DuMessage>(i, "messages");
    const du_release = str(i, "du_release") || CURRENT_DU_RELEASE;
    if (i.op !== "interpret") {   // parse only: normalize the JSON v2 payload (never the PDF) into the interpretation input
      const mapped = mapMessages(messages, rulesOf(i, rt), du_release);
      const by: Record<string, number> = {}; for (const m of mapped) by[m.section] = (by[m.section] ?? 0) + 1;
      return { submission_id: str(i, "submission_id"), recommendation: str(i, "recommendation"), du_release, messages: mapped.length, by_section: by, unmapped: mapped.filter((m) => !m.rule).map((m) => m.message.id), validation_results: list<ValidationResult>(i, "validation_results").length, value_acceptance_offer: i.value_acceptance_offer ?? null, mi_requirement: i.mi_requirement ?? null, source: "json_v2" };
    }
    need(i, "submission_number", "policy_generation", "request_hash", "findings_received_at");
    const facts = factsIn(i);
    const input: InterpretInput = { application_id, submission_id: str(i, "submission_id"), submission_number: num(i, "submission_number"), is_final: flag(i, "is_final"), recommendation: str(i, "recommendation") as Recommendation, messages, validation_results: list<ValidationResult>(i, "validation_results"),
      value_acceptance_offer: (i.value_acceptance_offer as InterpretInput["value_acceptance_offer"]) ?? null, mi_requirement: (i.mi_requirement as InterpretInput["mi_requirement"]) ?? null, du_release, policy_generation: str(i, "policy_generation") as PolicyGeneration, request_hash: str(i, "request_hash"), findings_received_at: str(i, "findings_received_at"), interpreted_at: ctx.now, facts, rules: rulesOf(i, rt),
      prior_conditions: Array.isArray(i.prior_conditions) ? (i.prior_conditions as Condition[]) : rows<Condition>(rt, "conditions", (d) => d.application_id === application_id), prior: (i.prior as InterpretInput["prior"]) ?? null, financials: i.financials ? financialsIn(i) : null, agent_decision_id: optStr(i, "agent_decision_id") };
    const r = interpretFindings(ctx.events, input, ctx.actor);
    persistResult(rt, ctx, r);
    return { interpretation: r.interpretation, conditions: r.conditions.map((c) => c.condition_id), superseded: r.superseded.map((c) => c.condition_id), investigations: r.investigations.map((v) => v.investigation_id), triage: r.triage.map((t) => t.message_id), proposals: r.proposals.map((p) => p.proposal_id), events: r.events.map((e) => e.type) };
  }), guardrails: [
    never("DU_MESSAGE_DROPPED", "23.2 guardrails: never drop an unmapped message", (i) => i.drop_unmapped === true || i.ignore_unmapped === true, "an unknown message id goes to the triage queue and opens COND_DU_UNMAPPED_MESSAGE; it is never dropped"),
    never("PRIORITY_ACTIONS_NOT_SOURCE_OF_TRUTH", "23.2 rule 2: Priority Actions are 'never used as the source of truth' (\"Not all DU messages will have a condensed version\")", (i) => i.source === "priority_actions" || i.source === "pdf", "the detailed JSON v2 messages drive conditions; the PDF is stored, never parsed for logic"),
  ] },
  { name: "mapMessages", kind: "read", handler: compute((i, _ctx, rt) => {
    const messages = list<DuMessage>(i, "messages"); const du_release = str(i, "du_release") || CURRENT_DU_RELEASE;
    return { du_release, mapped: mapMessages(messages, rulesOf(i, rt), du_release).map((m) => ({ id: m.message.id, section: m.section, action: m.action, template: m.rule?.condition_template_code ?? null, stage: m.rule?.stage ?? null, category: m.rule?.category ?? null })) };
  }), guardrails: [never("DU_MESSAGE_DROPPED", "23.2 guardrails: never drop an unmapped message", (i) => i.drop_unmapped === true, "unknown ids map to `unmapped` (triage + COND_DU_UNMAPPED_MESSAGE), never to nothing")] },
  { name: "openCondition", kind: "act", handler: compute((i, ctx, rt) => {
    const application_id = appOf(i, ctx);
    if (i.op === "clear_unmapped") {
      need(i, "condition_id", "reason"); const c = rt.store.require("conditions", str(i, "condition_id")).data as unknown as Condition;
      const next = clearUnmappedCondition(c, ctx.actor, { reason: str(i, "reason"), ...(optStr(i, "mapped_to") ? { mapped_to: optStr(i, "mapped_to")! } : {}) }, ctx.now);
      persist(rt, ctx, "conditions", next.condition_id, next);
      ctx.events.append({ type: "condition.cleared", applicationId: application_id, actor: ctx.actor, payload: { application_id, condition_id: next.condition_id, template_code: next.template_code, cleared_by: ctx.actor.id, reason: str(i, "reason"), mapped_to: optStr(i, "mapped_to") } });
      return next;
    }
    if (i.op === "ctc_blockers") return ctcBlockers(rows<Condition>(rt, "conditions", (d) => d.application_id === application_id), rows<Investigation23>(rt, "investigations", (d) => d.application_id === application_id));
    need(i, "template_code", "category", "stage", "text", "internal_text");
    const r = openCondition(ctx.events, { application_id, submission_id: optStr(i, "submission_id"), template_code: str(i, "template_code"), category: str(i, "category") as ConditionCategory, stage: str(i, "stage") as ConditionStage, text: str(i, "text"), internal_text: str(i, "internal_text"), borrower_id: optStr(i, "borrower_id"), du_message_id: optStr(i, "du_message_id"), evidence_kinds: list<string>(i, "evidence_kinds"), auto_clear_rule: optStr(i, "auto_clear_rule"), requires_role: (optStr(i, "requires_role") as Condition["requires_role"]) ?? null, source: (optStr(i, "source") as Condition["source"]) ?? "du", opened_at: ctx.now, due_at: optStr(i, "due_at"), ...(typeof i.borrower_visible === "boolean" ? { borrower_visible: i.borrower_visible as boolean } : {}), message_ids: [...list<string>(i, "message_ids"), ...idsInStore(rt, application_id)] }, ctx.actor);
    persist(rt, ctx, "conditions", r.condition.condition_id, r.condition);
    return r.condition;
  }), guardrails: [
    NO_DU_TO_BORROWER("openCondition"),
    never("DU_REQUIREMENT_WEAKENED", "23.2 guardrails: never re-word a DU requirement into something weaker (B3-2-04: 'a more comprehensive level of documentation is always acceptable')", (i) => i.weaker_than_du === true || i.reduce_documentation === true || i.evidence_level === "below_du", "a condition's evidence level is DU's stated level or higher — never lower"),
    needsRole("UNMAPPED_CLEAR_NEEDS_REVIEWER", "23.2 T2: CTC is blocked until the unmapped message is mapped or cleared by `underwriting_reviewer`", (i) => i.op === "clear_unmapped", ["underwriting_reviewer"], "only underwriting_reviewer clears or maps COND_DU_UNMAPPED_MESSAGE"),
  ] },
  { name: "openInvestigation", kind: "act", handler: compute((i, ctx, rt) => {
    const application_id = appOf(i, ctx);
    if (i.op === "close") { need(i, "investigation_id", "rationale"); const v = rt.store.require("investigations", str(i, "investigation_id")).data as unknown as Investigation23; const r = closeInvestigation(ctx.events, v, str(i, "rationale"), ctx.now, ctx.actor); persist(rt, ctx, "investigations", r.investigation.investigation_id, r.investigation); return r.investigation; }
    need(i, "submission_id", "message_id", "red_flag"); const red_flag = str(i, "red_flag") as RedFlag; if (!RED_FLAGS.includes(red_flag)) throw new RangeError(`23.2 tool needs red_flag ∈ {${RED_FLAGS.join(", ")}}`);
    const r = openRedFlagInvestigation(ctx.events, { application_id, submission_id: str(i, "submission_id"), message_id: str(i, "message_id"), red_flag, du_text: str(i, "du_text"), at: ctx.now }, ctx.actor);
    persist(rt, ctx, "investigations", r.investigation.investigation_id, r.investigation);
    return r.investigation;
  }), guardrails: [never("RED_FLAG_SHOWN_TO_BORROWER", "23.2 mapping table: potential red flags carry no condition — 'does not affect the underwriting recommendation' but must be investigated; never borrower-facing", (i) => i.borrower_visible === true || i.open_condition === true, "a red-flag investigation is never rendered to the borrower and opens no needs-list item")] },
  { name: "evaluateHomeReady", kind: "act", handler: compute((i, ctx, rt) => {
    const application_id = appOf(i, ctx); need(i, "property_fips", "ami_source", "ami_annual_cents", "ami_dataset_version");
    const incomes = list<unknown>(i, "qualifying_monthly_income_cents").map((x) => cents(x)); if (!incomes.length) throw new RangeError("23.2 tool needs qualifying_monthly_income_cents[] (all note signers)");
    const e = evaluateHomeReady({ application_id, property_fips: str(i, "property_fips"), ami_source: str(i, "ami_source"), ami_annual_cents: cents(i.ami_annual_cents), qualifying_monthly_income_cents: incomes, ami_dataset_version: str(i, "ami_dataset_version"), api_response_document_id: optStr(i, "api_response_document_id"), evaluated_at: ctx.now });
    persist(rt, ctx, "homeready_evaluations", e.evaluation_id, e); recordHomeReadyEvaluation(ctx.events, e, ctx.actor);
    const restructure = !e.eligible && i.financials ? computeRestructure(financialsIn(i), { structural_reasons: [{ message_id: "E5003", reason_code: "HOMEREADY_INCOME_OVER_AMI_LIMIT", lever: "remove_homeready", text: "income exceeds the AMI limit" }], recommendation: "approve_ineligible" }) : null;
    return { evaluation: e, remove_homeready_lever: restructure?.levers.find((l) => l.kind === "remove_homeready") ?? null };
  }), guardrails: [
    never("NON_FNMA_AMI", "B5-6-01: lenders 'may not rely on other published versions' of AMI; 23.2 guardrail: never rely on non-Fannie Mae AMI data", (i) => i.ami_source !== undefined && !["du_message", "ami_api", "web_tool"].includes(String(i.ami_source)), "AMI comes from DU's message, the AMI Lookup and HomeReady Evaluation API or the web tool — never HUD or other published AMIs"),
    never("STALE_AMI_DATASET", "23.2 edge case 'AMI API outage': never proceed on cached data older than the current dataset version", (i) => i.cached === true && i.dataset_current !== true, "a cached AMI is used only when its dataset version is the current one"),
    never("NON_BORROWER_HOUSEHOLD_INCOME_COUNTED", "23.2 rule 2: non-borrower household income is no longer a DU income type (Sept 25, 2026) and is never counted", (i) => i.non_borrower_household_income_cents !== undefined && cents(i.non_borrower_household_income_cents) > 0n, "only note signers' qualifying income is counted"),
  ] },
  { name: "verifyEducationCertificate", kind: "act", handler: compute((i, ctx, rt) => {
    const application_id = appOf(i, ctx); need(i, "borrower_id");
    const id = `edu:${application_id}:${str(i, "borrower_id")}`;
    if (i.op === "require") { need(i, "basis"); const r = requireEducation(ctx.events, { application_id, borrower_ids: list<string>(i, "borrower_ids").length ? list<string>(i, "borrower_ids") : [str(i, "borrower_id")], basis: str(i, "basis") as RequirementBasis, closing_date: optDate(i, "closing_date"), at: ctx.now }, ctx.actor); for (const rec of r.records) persist(rt, ctx, "homeownership_education_records", rec.record_id, rec); return { records: r.records, required: r.event !== null }; }
    const existing = rt.store.get("homeownership_education_records", id)?.data as unknown as EducationRecord | undefined;
    if (i.op === "receive") {
      need(i, "certificate_document_id", "provider_name", "provider_type", "course_type", "completed_on");
      const provider_type = str(i, "provider_type") as ProviderType; if (!PROVIDER_TYPES.includes(provider_type)) throw new RangeError(`23.2 tool needs provider_type ∈ {${PROVIDER_TYPES.join(", ")}}`);
      const base: EducationRecord = existing ?? { record_id: id, application_id, borrower_id: str(i, "borrower_id"), requirement_basis: (optStr(i, "basis") as RequirementBasis) ?? "none", provider_name: null, provider_type: null, course_type: null, certificate_document_id: null, completed_on: null, verified_at: null, counseling_within_12m: false, status: "required_open" };
      const r = receiveEducationCertificate(ctx.events, base, { certificate_document_id: str(i, "certificate_document_id"), provider_name: str(i, "provider_name"), provider_type, course_type: str(i, "course_type") === "counseling" ? "counseling" : "education", completed_on: dateIn(i, "completed_on"), at: ctx.now }, ctx.actor);
      persist(rt, ctx, "homeownership_education_records", id, r.record); return r.record;
    }
    need(i, "certificate_document_id", "borrower_name", "name_on_certificate", "closing_date");
    if (!existing) throw new RangeError(`no homeownership_education_records row ${id} — op=receive the certificate first`);
    const r = verifyEducationCertificate(ctx.events, existing, { certificate_document_id: str(i, "certificate_document_id"), borrower_name: str(i, "borrower_name"), name_on_certificate: str(i, "name_on_certificate"), closing_date: dateIn(i, "closing_date"), verified_at: ctx.now, ...(Array.isArray(i.provider_allowlist) ? { provider_allowlist: i.provider_allowlist as { name: string; type: ProviderType }[] } : {}), lender_affiliates: list<string>(i, "lender_affiliates") }, ctx.actor);
    persist(rt, ctx, "homeownership_education_records", id, r.record);
    if (r.escalate) rt.escalations.open({ kind: "underwriting_reviewer", applicationId: application_id, payload: { reason: "education provider not on the HUD/NIS lists — reviewer decides acceptability (23.2 edge case)", record_id: id, provider_name: existing.provider_name } }, ctx.actor);
    return { record: r.record, checks: r.checks, escalated: r.escalate };
  }), guardrails: [
    never("EDUCATION_VERIFIED_WITHOUT_CERTIFICATE", "B2-2-06: 'must retain a copy of the certificate of course completion in the loan file'; 23.2 guardrail: never mark education verified without the certificate document", (i) => (i.op === undefined || i.op === "verify") && i.borrower_id !== undefined && !i.certificate_document_id, "verification requires the classified education_certificate document id"),
    never("LENDER_AFFILIATE_PROVIDER", "B2-2-06: providers must be 'independent of the lender'; 23.2 edge case: default reject if the provider is the lender or an affiliate", (i) => i.provider_is_lender_or_affiliate === true, "a course from the lender or an affiliate is not acceptable"),
  ] },
  { name: "computeRestructure", kind: "act", handler: compute((i) => {
    const f = financialsIn(i);
    const r = computeRestructure(f, { structural_reasons: list(i, "structural_reasons"), ...(optStr(i, "recommendation") ? { recommendation: optStr(i, "recommendation") as Recommendation } : {}) });
    return { current: r.current, levers: r.levers, recommended: r.recommended, decline_candidate: r.decline_candidate, manual_underwriting_offered: r.manual_underwriting_offered };
  }), guardrails: [
    never("RESTRUCTURE_CHANGES_OCCUPANCY_OR_INCOME", "23.2 guardrails: never propose a restructure that changes the borrower's stated occupancy or income", (i) => i.change_occupancy !== undefined || i.change_income !== undefined || i.occupancy_override !== undefined || i.income_override !== undefined, "levers are loan amount, term, product, liability payoff, assets/reserves, MI option, occupancy correction with evidence, co-borrower change at the borrowers' request — never stated occupancy or income"),
    never("MANUAL_UNDERWRITING_NOT_IN_POLICY", "23.2-Q1 (adopted): DU Approve/Eligible only; no manual underwriting; no variances", (i) => i.manual_underwrite === true || i.negotiated_terms === true, "Refer with Caution / Out of Scope / Approve/Ineligible loans are restructured or declined; no manual underwriting path is offered"),
  ] },
  { name: "quote", kind: "act", handler: compute((i, _ctx, rt) => {
    const f = financialsIn(i); const loan = i.loan_amount_cents !== undefined ? cents(i.loan_amount_cents) : f.loan_amount_cents;
    const p = pitiaFor(f, loan); const limits = loanLimitCheck(loan, f.units ?? 1, f.county_limit_cents ?? null); const mi = miCoverage(p.ltv_x100, f.product, f.term_months);
    const svc = rt.services["pricing"] as { quote?: (input: Record<string, unknown>) => unknown } | undefined;
    const engine = svc?.quote ? svc.quote({ ...f, loan_amount_cents: loan }) : null;
    return { loan_amount_cents: loan.toString(), pitia: p, mi_coverage: mi, limits: { high_balance: limits.high_balance, over_limit: limits.over_limit, sfc: limits.high_balance ? ["808"] : [] }, sfc: sfcAssembly({ transaction_type: f.transaction_type, score_model: (optStr(i, "score_model") as "classic_fico" | "vantagescore_4" | null) ?? null, homeready: f.product === "homeready", counseling_credit: flag(i, "counseling_credit"), value_acceptance_exercised: flag(i, "value_acceptance_exercised"), va_pd_exercised: flag(i, "va_pd_exercised"), high_balance: limits.high_balance, community_seconds: flag(i, "community_seconds"), temporary_buydown: flag(i, "temporary_buydown"), inter_vivos_trust: flag(i, "inter_vivos_trust"), texas_50a6: flag(i, "texas_50a6") }), pricing_engine: engine, rule_set_versions: RULE_SETS_23_2 };
  }), guardrails: [never("NON_FNMA_AMI", "23.2 guardrails: never rely on non-Fannie Mae AMI data (the FTHB ≤ 100 % AMI waiver is evaluated by 20.4 on the DU/API AMI)", (i) => i.ami_source !== undefined && !["du_message", "ami_api", "web_tool"].includes(String(i.ami_source)), "AMI for the LLPA waiver comes from DU or the AMI API only")] },
  { name: "proposeRestructure", kind: "act", handler: compute((i, ctx, rt) => {
    const application_id = appOf(i, ctx);
    if (i.op === "accept") { need(i, "proposal_id", "changed_circumstance_id"); const p = rt.store.require("restructure_proposals", str(i, "proposal_id")).data as unknown as RestructureProposal; const r = acceptRestructure(ctx.events, p, { at: ctx.now, reviewer_id: optStr(i, "reviewer_id"), changed_circumstance_id: str(i, "changed_circumstance_id") }, ctx.actor); persist(rt, ctx, "restructure_proposals", p.proposal_id, r.proposal); return r.proposal; }
    if (i.op === "expire") { need(i, "proposal_id"); const p = rt.store.require("restructure_proposals", str(i, "proposal_id")).data as unknown as RestructureProposal; const r = expireRestructure(ctx.events, p, ctx.now, ctx.actor); persist(rt, ctx, "restructure_proposals", p.proposal_id, r.proposal); return r.proposal; }
    const lever = i.lever as Lever | undefined; if (!lever || typeof lever !== "object" || !lever.kind) throw new RangeError("23.2 tool needs lever (a computeRestructure lever with its arithmetic)");
    const r = proposeRestructure(ctx.events, { application_id, trigger_submission_id: optStr(i, "trigger_submission_id"), lever: { ...lever, pitia: asBig(lever.pitia, ["loan_amount_cents", "pi_cents", "mi_cents", "taxes_cents", "insurance_cents", "debts_cents", "obligations_cents"]) }, from: (i.from as Record<string, unknown> | undefined) ?? {}, initiated_by: i.initiated_by === "borrower" ? "borrower" : "sm", at: ctx.now, changed_circumstance_id: optStr(i, "changed_circumstance_id") }, ctx.actor);
    persist(rt, ctx, "restructure_proposals", r.proposal.proposal_id, r.proposal);
    return r.proposal;
  }), guardrails: [
    never("RESTRUCTURE_CHANGES_OCCUPANCY_OR_INCOME", "23.2 guardrails: never propose a restructure that changes the borrower's stated occupancy or income", (i) => { const l = i.lever as { kind?: string; to?: Record<string, unknown> } | undefined; return !!l && (["occupancy_change", "income_change"].includes(String(l.kind)) || l.to?.occupancy !== undefined || l.to?.monthly_income_cents !== undefined); }, "a proposal never changes stated occupancy or income"),
    needsRole("COUNTEROFFER_NEEDS_REVIEWER", "23.2 guardrails: never send a counteroffer or denial without `underwriting_reviewer` (Reg B §1002.9; 21.6 NTC_REGB_1002_9_COUNTEROFFER)", (i) => i.communicate_to_borrower === true || i.send_counteroffer === true || i.send_denial === true || (i.op === "accept" && i.regb_treatment === "counteroffer" && !i.reviewer_id), ["underwriting_reviewer"], "a counteroffer or denial reaches the borrower only after underwriting_reviewer approval; the agent proposes and computes, never communicates"),
    never("MANUAL_UNDERWRITING_NOT_IN_POLICY", "23.2-Q1 (adopted): no manual underwriting; no variances", (i) => i.manual_underwrite === true || (i.lever as { kind?: string } | undefined)?.kind === "manual_underwrite", "the lawful paths are a borrower-accepted restructure that yields Approve/Eligible or a Reg B decision via 21.6"),
  ] },
  { name: "writeDecision", kind: "write", handler: compute((i, ctx, rt) => {
    if (i.op === "record") {
      need(i, "interpretation_id", "model_version", "prompt_version", "rationale");
      const interp = rt.store.require("du_findings_interpretations", str(i, "interpretation_id")).data as unknown as InterpretResult["interpretation"];
      const app = interp.application_id;
      const r: InterpretResult = { interpretation: interp, mapped: [], conditions: rows<Condition>(rt, "conditions", (d) => d.application_id === app && d.du_submission_id === interp.submission_id), superseded: [], investigations: rows<Investigation23>(rt, "investigations", (d) => d.submission_id === interp.submission_id), triage: [], education: rows<EducationRecord>(rt, "homeownership_education_records", (d) => d.application_id === app), restructure: null, proposals: rows<RestructureProposal>(rt, "restructure_proposals", (d) => d.trigger_submission_id === interp.submission_id), events: [] };
      const rec = decisionRecord23_2(r, { model_version: str(i, "model_version"), prompt_version: str(i, "prompt_version"), rationale: str(i, "rationale") });
      decision()({ ...i, agent: "underwriter", action: "23.2.interpret", rule_set_version: `du_message_rules@${RULE_SETS_23_2.du_message_rules}; fnma.selling@${RULE_SETS_23_2["fnma.selling"]}`, subject: { kind: "du_findings_interpretations", id: interp.interpretation_id }, rationale: rec.rationale }, ctx);
      return rec;
    }
    return decision()(i, ctx);
  }), guardrails: [never("REASON_TEXT_NAMES_DU", "§1002.9(b)(2) / 00a-fed §3.1: DU findings are a reason source, never the reason text", (i) => typeof i.rationale === "string" && /\bDU\b|Desktop Underwriter|Refer with Caution|Approve\/Ineligible/i.test(i.rationale as string), "reasons are specific ('debt-to-income ratio of 53.32% exceeds the 50% maximum'), never the DU recommendation")] },
  { name: "openEscalation", kind: "act", handler: escalate("underwriting_reviewer") },
]);
