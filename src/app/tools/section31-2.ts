/**
 * §31.2 process-owned tools — bus tools for 31.2 defined with `defineTools("31.2", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 31.2; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * Agents (spec "AI agent design"): `qc-audit` (independent evaluation and monitoring — inventory, assessments, eval
 * suites, bias tests, monthly/quarterly runs, reason-accuracy replays, LDA searches, packs, cards) and
 * `compliance-sentinel` (deploy-gate / Colorado / California gate evaluation, timers, escalations). Tools, verbatim from
 * the paragraph: `inventory.upsert`, `assess.draft`, `eval.run(suite, version)`, `bias.runSuite` (19.4's suite over
 * `runBiasSuite`), `monitor.run(scope, period)`, `monitor.test(metric, dimension)`, `reasons.replay(sample)`,
 * `lda.search(subject)`, `drift.watch`, `pack.compile`, `cards.render`, `gate.evaluate`, `escalations.open`, `timers.read`.
 *
 * Guardrails (spec sentences): the agents never approve a deployment (gate.evaluate{op=deploy} is the officer's; a
 * high_consequential system also needs the partner officer's approval record), never change a decision rule set or prompt
 * in response to a finding (lda.search / monitor.run refuse `apply_change`), never mark a finding `closed` without an
 * `officer` disposition (monitor.run{op=close_review} is officer-only), never send row-level demographic data to a model
 * (monitor.run refuses restricted fields in row-level input), never contact a borrower about a fair-lending review
 * (`notify_borrower` refused everywhere), and never draft consumer explanations that cite a prohibited basis
 * (rationale guard on reasons.replay / monitor.run{op=decision_record}).
 *
 * Events appended (timers-31-2.ts arms and closes on them): `ai_system.registered` / `ai_system.changed{domain=origination,
 * substantial, co_covered, change_date}` / `ai_system.retired` / `ai_system.restricted` / `ai_system.unrestricted`,
 * `ai_system.assessment.drafted`, `ai_system.assessed{kind, approved, completed_at}`, `ai_eval.run.completed`,
 * `ai.monitor.drift_detected{metric, detected_at}` / `ai.monitor.drift_disposed{disposition}`, `vendor.sla_breach.logged`
 * (19.3's name; clause VERSION_CHANGE_NOTICE), `ai.bias_tests.completed` (19.4), `agent_run.quarantined` (19.4),
 * `ai_system.partner_notified`, `co_admt.developer_docs.delivered{acknowledged}`, `co_admt.material_update.notified`,
 * `ai_system.deploy.approved` / `ai_system.deploy.blocked`, `ai_governance.path.routed{gate, path}`,
 * `jurisdiction_rules.ai_governance.updated`, `ca_admt.readiness.confirmed`, `ca_cppa.attestation.filed`,
 * `fair_lending.run.completed{scope, period, kind, controls, all_scopes}`, `fair_lending.finding.flagged{flag, flagged_at}`,
 * `fair_lending.review.opened` / `fair_lending.review.closed`, `fair_lending.complaint.received` / `.triaged`,
 * `reason_accuracy.sample.completed{accuracy}`, `reason_accuracy.correction.required`, `lda.search.completed`,
 * `ai_governance.pack.issued{period}`, `fnma.disclosure.package.compiled`, `ai_rights.request.received` / `.completed{kind}`,
 * `ai_system.human_involvement.flagged`, `agent_decision.recorded{human_involvement_level}`.
 */
import { defineTools, escalate, compute, never, needsRole, timerOps, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { hasRole } from "../roles.ts";
import type { CommandContext } from "../commands.ts";
import { evaluateGate } from "../evaluators.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import { runBiasSuite, type BiasTestKind } from "../../domain/data-security/ops-19-4.ts";
import type { BiasTests } from "../../domain/data-security/fairlending.ts";
import { classifySystem, originationDeployGate, partnerNoticeDue, assessmentNextDue, systemState, inputsAttestation, disparityTest, reviewOpensOn, reviewDue, reviewMayClose, pricingExceptionReview, MONTHLY_SCOPES, reasonAccuracy, correctedStatementDue, leakageTest, detectDrift, driftAutoRestrict, coDeveloperDocsGate, systemCard, caAdmtReadinessGate, fnmaDisclosurePackage, reviewerOverrideTest, policyReviewStatus, decisionRecord, rationaleGuard, ldaSelect, rightsRequestDue, developerRecordRetainUntil, RESTRICTED_INPUTS, HIGH_RISK_DECISION_KINDS, type AgentPackage, type DecisionKind, type DisparityInput, type Pack, type Sr117Class, type ReasonReplay } from "../../domain/governance/ops-31-2.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const today = (ctx: CommandContext): PlainDate => D(ctx.now.slice(0, 10));
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const row = (rt: ToolRuntime, kind: string, id: string): Record<string, unknown> => { const r = rt.store.get(kind, id); if (!r) throw new RangeError(`no ${kind} ${id}`); return r.data; };
const QC = "qc-audit";
const GUARD = "31.2 guardrails: the agents never approve a deployment, never change a decision rule set or prompt in response to a finding, never mark a finding `closed` without an `officer` disposition, never send row-level demographic data to a model, never contact a borrower about a fair-lending review, and never draft consumer explanations that cite a prohibited basis";
const NO_BORROWER_CONTACT = never("NO_BORROWER_CONTACT_ON_FL_REVIEW", GUARD, (i) => flag(i, "notify_borrower") || flag(i, "contact_borrower"), "the agents never contact a borrower about a fair-lending review — corrected notices go through 21.6");
const NO_RULE_CHANGE = never("NO_RULE_CHANGE_ON_FINDING", GUARD, (i) => flag(i, "apply_change") || flag(i, "change_rule_set") || flag(i, "change_prompt"), "corrective actions are versioned rule-set/prompt changes approved by `officer` and re-gated through the deploy gate — never applied by the agent in response to a finding");
/** Row-level restricted demographic fields must never leave the enclave toward a model: only aggregates (n / events) are accepted. */
const restrictedRowsPresent = (i: ToolInput): boolean => list<Record<string, unknown>>(i.rows).some((r) => r && typeof r === "object" && Object.keys(r).some((k) => (RESTRICTED_INPUTS as readonly string[]).includes(k.toLowerCase())));
const NO_ROW_LEVEL_DEMOGRAPHICS = never("NO_ROW_LEVEL_DEMOGRAPHICS_TO_MODEL", GUARD + "; integrations: restricted demographic enclave — deterministic jobs only; aggregates leave", restrictedRowsPresent, "row-level demographic data never leaves the enclave — pass population counts by dimension, not rows");
const appId = (i: ToolInput, ctx: CommandContext): string => { const id = str(i, "application_id") || ctx.applicationId || ""; if (!id) throw new RangeError("application_id is required"); return id; };
const sysEvent = (ctx: CommandContext, type: string, id: string, payload: Record<string, unknown>): DomainEvent => ctx.events.append({ type, loanId: ctx.loanId, aggregate: { kind: "ai_systems", id }, actor: ctx.actor, payload: { ...payload, origination: true } });

// ---------------------------------------------------------------- qc-audit tools
type Handler = (i: ToolInput, ctx: CommandContext, rt: ToolRuntime) => unknown;
  // ---- rule 1: inventory (ai_systems origination columns), jurisdiction position, restrictions, consumer AI-rights requests
const versionOps: Handler = (i, ctx, rt) => {
      const op = str(i, "op") || "version";
      switch (op) {
        case "version": {
          need(i, "id", "agent_package", "version"); const id = str(i, "id");
          const cur = rt.store.get("ai_systems", id)?.data ?? null;
          const cls = classifySystem({ agent_package: str(i, "agent_package") as AgentPackage, ...(i.model_class ? { model_class: str(i, "model_class") as Sr117Class } : {}), ...(Array.isArray(i.decision_kinds) ? { decision_kinds: strings(i.decision_kinds) as DecisionKind[] } : {}) });
          const changeDate = i.change_date ? D(str(i, "change_date")) : today(ctx);
          const substantial = flag(i, "substantial");
          const co_covered = cls.materially_influences_consequential_decision && (cls.co_admt_role === "developer" || cls.co_admt_role === "both");
          const data = { id, code: id, name: str(i, "name") || cur?.name || str(i, "agent_package"), domain: "origination", vendor_id: str(i, "vendor_id") || cur?.vendor_id || null, purpose: str(i, "purpose") || cur?.purpose || null, human_touchpoints: Array.isArray(i.human_touchpoints) ? strings(i.human_touchpoints) : strings(cur?.human_touchpoints), agent_package: cls.agent_package, version: str(i, "version"), prompt_version: str(i, "prompt_version") || cur?.prompt_version || null, model_version: str(i, "model_version") || cur?.model_version || null, rule_set_versions: i.rule_set_versions ?? cur?.rule_set_versions ?? {}, decision_kinds: cls.decision_kinds, materially_influences_consequential_decision: cls.materially_influences_consequential_decision, co_admt_role: cls.co_admt_role, co_covered, ca_admt_significant_decision: cls.ca_admt_significant_decision, ca_substantially_replaces_human: cls.ca_substantially_replaces_human, sr11_7_model_class: cls.sr11_7_model_class, bias_test_cadence: cls.bias_test_cadence, risk_tier: cls.risk_tier, eval_suite_version: str(i, "eval_suite_version") || cur?.eval_suite_version || null, decision_record_schema_version: str(i, "decision_record_schema_version") || cur?.decision_record_schema_version || "1",
            // a new version re-opens the pipeline: assessment/eval/bias/partner notice/card are per version
            assessment_kind: null, assessment_approved: false, eval_pass: false, bias_tests_pass: null, partner_notified_at: null, co_docs_delivered_to_deployer_at: null, co_docs_acknowledged_at: null, deployed_at: null, restricted_decision_kinds: [], change_date: changeDate, substantial, status: "registered", retention: "ai_governance_7y" };
          rt.store.put("ai_systems", id, data, ctx.actor, ctx.now);
          if (!cur) sysEvent(ctx, "ai_system.registered", id, { id, name: data.name, domain: "origination", agent_package: cls.agent_package, version: data.version, risk_tier: cls.risk_tier, high_consequential: cls.risk_tier === "high_consequential", decision_kinds: cls.decision_kinds, registered_on: changeDate });
          const changed = sysEvent(ctx, "ai_system.changed", id, { id, name: data.name, domain: "origination", agent_package: cls.agent_package, version: data.version, component: str(i, "component") || (cur ? "prompt" : "initial_version"), substantial, change_date: changeDate, risk_tier: cls.risk_tier, high_consequential: cls.risk_tier === "high_consequential", co_covered, prompt_version: data.prompt_version, model_version: data.model_version, partner_notice_due: substantial ? partnerNoticeDue(changeDate) : null });
          return { ...data, state: systemState(data), event_id: changed.id, partner_notice_due: substantial ? partnerNoticeDue(changeDate) : null, timers: substantial ? ["SM_O122_ORIGINATION_AI_DEPLOY_GATE", "SM_O122_MODEL_CHANGE_NOTICE_TO_PARTNER_10BD", ...(co_covered ? ["CO_SB26_189_1702_MATERIAL_UPDATE_NOTICE"] : [])] : ["SM_O122_ORIGINATION_AI_DEPLOY_GATE"] };
        }
        case "partner_notified": {
          need(i, "id", "notified_at"); const id = str(i, "id"); const cur = row(rt, "ai_systems", id);
          const data = rt.store.put("ai_systems", id, { partner_notified_at: str(i, "notified_at"), partner_notice_document_id: str(i, "document_id") || null }, ctx.actor, ctx.now).data;
          sysEvent(ctx, "ai_system.partner_notified", id, { ai_system_id: id, version: cur.version, notified_at: str(i, "notified_at"), document_id: str(i, "document_id") || null });
          return { ...data, state: systemState(data) };
        }
        case "jurisdiction": {
          need(i, "state", "ai_governance"); const state = str(i, "state"); const ag = i.ai_governance as Record<string, unknown>;
          const prev = rt.store.get("jurisdiction_rules", state)?.data ?? {};
          const data = rt.store.put("jurisdiction_rules", state, { ...prev, state, ai_governance: { ...((prev.ai_governance as Record<string, unknown> | undefined) ?? {}), ...ag } }, ctx.actor, ctx.now).data;
          const ca = ((data.ai_governance as Record<string, unknown>).ca_admt as Record<string, unknown> | undefined) ?? {};
          const co = ((data.ai_governance as Record<string, unknown>).co_admt as Record<string, unknown> | undefined) ?? {};
          ctx.events.append({ type: "jurisdiction_rules.ai_governance.updated", loanId: ctx.loanId, actor: ctx.actor, payload: { state, ca_admt_applicability_position: ca.applicability_position ?? null, ca_admt_applies_from: ca.applies_from ?? "2027-01-01", co_admt_applies_from: co.applies_from ?? "2027-01-01", fair_lending_disparate_impact: (data.ai_governance as Record<string, unknown>).fair_lending_disparate_impact ?? null, origination: true } });
          return data;
        }
        case "ca_readiness": {
          need(i, "preuse_notice_live", "optout_route_live", "access_procedure_live");
          const data = rt.store.put("ca_admt_readiness", "CA", { preuse_notice_live: flag(i, "preuse_notice_live"), optout_route_live: flag(i, "optout_route_live"), access_procedure_live: flag(i, "access_procedure_live"), preuse_notice_template: "NTC_CA_CPPA_7220_ADMT_PRE_USE", confirmed_at: ctx.now }, ctx.actor, ctx.now).data;
          const live = data.preuse_notice_live === true && data.optout_route_live === true && data.access_procedure_live === true;
          if (live) ctx.events.append({ type: "ca_admt.readiness.confirmed", loanId: ctx.loanId, actor: ctx.actor, payload: { ...data, origination: true } });
          return { ...data, live, gate: "CA_CPPA_7200_ADMT_READINESS_20270101" };
        }
        case "ca_attestation": {
          need(i, "document_id");
          ctx.events.append({ type: "ca_cppa.attestation.filed", loanId: ctx.loanId, actor: ctx.actor, payload: { document_id: str(i, "document_id"), filed_at: ctx.now, origination: true } });
          return { filed: true, timer: "CA_CPPA_7157_ATTESTATION_20280401" };
        }
        case "restrict": case "unrestrict": {
          need(i, "id", "reason"); const id = str(i, "id"); const cur = row(rt, "ai_systems", id);
          const kinds = op === "restrict" ? [...new Set([...strings(cur.restricted_decision_kinds), ...strings(i.decision_kinds)])] : strings(cur.restricted_decision_kinds).filter((k) => !strings(i.decision_kinds).includes(k));
          if (op === "unrestrict") need(i, "eval_run_id");   // "until re-tested"
          const data = rt.store.put("ai_systems", id, { restricted_decision_kinds: kinds, status: systemState({ ...cur, restricted_decision_kinds: kinds }) }, ctx.actor, ctx.now).data;
          sysEvent(ctx, op === "restrict" ? "ai_system.restricted" : "ai_system.unrestricted", id, { ai_system_id: id, decision_kinds: strings(i.decision_kinds), restricted_decision_kinds: kinds, reason: str(i, "reason"), eval_run_id: str(i, "eval_run_id") || null });
          return { ...data, state: systemState(data) };
        }
        case "retire": { need(i, "id"); const id = str(i, "id"); row(rt, "ai_systems", id); const data = rt.store.put("ai_systems", id, { retired_at: ctx.now, status: "retired" }, ctx.actor, ctx.now).data; sysEvent(ctx, "ai_system.retired", id, { ai_system_id: id, retired_at: ctx.now }); return data; }
        case "rights_request": {
          const application_id = appId(i, ctx); need(i, "kind", "received_at"); const kind = str(i, "kind"); const received = D(str(i, "received_at").slice(0, 10));
          const id = str(i, "request_id") || `${application_id}:${kind}:${received}`;
          const routed = kind.startsWith("co_") ? "21.6" : kind === "ut_disclosure" ? "20.3" : kind.startsWith("ca_") ? "ca_path" : "31.2";
          const data = rt.store.put("consumer_ai_rights_requests", id, { request_id: id, application_id, kind, received_at: str(i, "received_at"), channel: str(i, "channel") || null, due_at: rightsRequestDue(kind, received), handler_id: str(i, "handler_id") || null, outcome: null, completed_at: null, notice_id: null, status: "routed", routed_to: routed, retention: "co_admt_3y" }, ctx.actor, ctx.now).data;
          ctx.events.append({ type: "ai_rights.request.received", loanId: ctx.loanId, applicationId: application_id, aggregate: { kind: "consumer_ai_rights_requests", id }, actor: ctx.actor, payload: { ...data } });
          return data;
        }
        case "rights_complete": {
          need(i, "request_id", "outcome"); const id = str(i, "request_id"); const cur = row(rt, "consumer_ai_rights_requests", id);
          const data = rt.store.put("consumer_ai_rights_requests", id, { outcome: str(i, "outcome"), completed_at: ctx.now, notice_id: str(i, "notice_id") || null, handler_id: str(i, "handler_id") || cur.handler_id || null, status: "closed" }, ctx.actor, ctx.now).data;
          ctx.events.append({ type: "ai_rights.request.completed", loanId: ctx.loanId, applicationId: String(cur.application_id), aggregate: { kind: "consumer_ai_rights_requests", id }, actor: ctx.actor, payload: { ...data } });
          return data;
        }
        default: throw new RangeError(`inventory.upsert op ${op} is not one of version/partner_notified/jurisdiction/ca_readiness/ca_attestation/restrict/unrestrict/retire/rights_request/rights_complete`);
      }
};

  // ---- rule 2: the pre-deployment / annual / material-modification / CA risk assessment (draft by the agent; approval by the officer)
const assessOps: Handler = (i, ctx, rt) => {
      const op = str(i, "op") || "draft";
      if (op === "approve") {
        need(i, "assessment_id"); const id = str(i, "assessment_id"); const cur = row(rt, "ai_impact_assessments", id);
        if (cur.inputs_attested !== true) throw new RangeError("an assessment whose inputs attestation failed cannot be approved — remove the prohibited inputs (rule 2b)");
        const sys = row(rt, "ai_systems", String(cur.ai_system_id));
        if (sys.risk_tier === "high_consequential" && (cur.kind === "pre_deployment" || cur.kind === "material_modification") && !flag(i, "partner_officer_approved") && !str(i, "partner_officer_approval_document_id")) throw new RangeError("a high_consequential system's pre_deployment/material_modification assessment needs the partner officer's approval record (open question 4)");
        const completed_at = str(i, "completed_at") || ctx.now.slice(0, 10);
        const data = rt.store.put("ai_impact_assessments", id, { approved: true, approved_by: ctx.actor.id, approved_role: "officer", partner_officer_approved: flag(i, "partner_officer_approved") || !!str(i, "partner_officer_approval_document_id"), completed_at, next_due_at: assessmentNextDue(D(completed_at.slice(0, 10))), status: "approved" }, ctx.actor, ctx.now).data;
        if (cur.kind === "pre_deployment" || cur.kind === "material_modification" || cur.kind === "annual") rt.store.put("ai_systems", String(cur.ai_system_id), { assessment_kind: cur.kind, assessment_approved: true, assessment_id: id, partner_officer_approved: data.partner_officer_approved, next_assessment_due: data.next_due_at }, ctx.actor, ctx.now);
        sysEvent(ctx, "ai_system.assessed", String(cur.ai_system_id), { assessment_id: id, ai_system_id: cur.ai_system_id, kind: cur.kind, approved: true, completed_at, next_due_at: data.next_due_at, residual_risk_rating: cur.residual_risk_rating, approved_by: ctx.actor.id });
        return { ...data, timer: cur.kind === "ca_cppa_risk_assessment" ? "CA_CPPA_7150_RISK_ASSESSMENT_20271231" : "SM_O122_AI_ASSESSMENT_ANNUAL_365" };
      }
      need(i, "ai_system_id", "kind", "purpose", "inputs"); const sysId = str(i, "ai_system_id"); const sys = row(rt, "ai_systems", sysId);
      const kind = str(i, "kind"); if (!["pre_deployment", "annual", "material_modification", "ca_cppa_risk_assessment", "post_incident", "post_finding"].includes(kind)) throw new RangeError(`assessment kind ${kind} is not one of pre_deployment/annual/material_modification/ca_cppa_risk_assessment/post_incident/post_finding`);
      const att = inputsAttestation(strings(i.inputs));
      const id = str(i, "assessment_id") || `${sysId}:${sys.version}:${kind}`;
      const data = rt.store.put("ai_impact_assessments", id, { assessment_id: id, ai_system_id: sysId, version: sys.version, kind, framework_refs: strings(i.framework_refs).length ? strings(i.framework_refs) : ["LL-2026-04", "SR 11-7", "NIST AI RMF 1.0", "CO 6-1-1702", "CA §7150"], purpose: str(i, "purpose"), decision_kinds: sys.decision_kinds, inputs_data_classes: strings(i.inputs), inputs_attested: att.attested, prohibited_inputs: att.prohibited, proxy_review: att.proxy_review, known_limitations: str(i, "known_limitations") || null, evaluation_summary: i.evaluation_summary ?? {}, bias_test_summary: i.bias_test_summary ?? {}, fair_lending_analysis: i.fair_lending_analysis ?? {}, lda_search_ids: strings(i.lda_search_ids), human_review_design: str(i, "human_review_design") || "underwriting_reviewer approves every denial/counteroffer/NOIA; second reviewer for Colorado reconsideration; mlo_of_record presents terms", monitoring_plan: i.monitoring_plan ?? { metrics: ["UW_APPROVAL_RATE", "UW_COUNTEROFFER_RATE", "PR_EXCEPTION_GRANT_RATE", "RA_REASON_ACCURACY"], cadence: "monthly", kill_switch: "per decision kind" }, vendor_dependencies: i.vendor_dependencies ?? {}, residual_risk_rating: str(i, "residual_risk_rating") || (sys.risk_tier === "high_consequential" ? "high" : "low"), approved: false, approved_by: null, completed_at: null, next_due_at: null, document_id: str(i, "document_id") || `DOC_AI_ASSESSMENT_${sysId}_${sys.version}`, status: "drafted", drafted_by: ctx.actor.id, retention: "ai_governance_7y" }, ctx.actor, ctx.now).data;
      sysEvent(ctx, "ai_system.assessment.drafted", sysId, { assessment_id: id, ai_system_id: sysId, kind, inputs_attested: att.attested, prohibited_inputs: att.prohibited });
      return { ...data, escalation: { kind: "officer", reason: `approve ${kind} assessment ${id}${sys.risk_tier === "high_consequential" ? " (partner officer approval also required)" : ""}` } };
};

  // ---- eval suites (golden set, reason-code accuracy, guardrail, robustness); silent provider updates surface as drift (T8)
const evalRun: Handler = (i, ctx, rt) => {
      need(i, "ai_system_id", "suite", "version"); const sysId = str(i, "ai_system_id"); const sys = row(rt, "ai_systems", sysId);
      const metrics = (i.metrics as Record<string, number> | undefined) ?? {}; const ranOn = i.ran_on ? D(str(i, "ran_on")) : today(ctx);
      const baseline = i.baseline as Record<string, number> | undefined;
      const providerVersion = str(i, "provider_model_version") || String(sys.model_version ?? "");
      const silent = !!providerVersion && providerVersion !== String(sys.model_version ?? "") && !flag(i, "provider_notice_received");
      const drift = baseline ? detectDrift({ baseline, observed: metrics, ...(i.tolerance !== undefined ? { tolerance: num(i, "tolerance") } : {}), detected_on: ranOn, decision_kinds: strings(sys.decision_kinds) as DecisionKind[], provider_version_changed_without_notice: silent }) : null;
      const pass = i.pass === undefined ? !(drift?.drift ?? false) : flag(i, "pass");
      const id = str(i, "run_id") || `${sysId}:${str(i, "version")}:${str(i, "suite")}:${ranOn}`;
      const data = rt.store.put("ai_eval_runs", id, { run_id: id, ai_system_id: sysId, suite_version: str(i, "suite"), version: str(i, "version"), component_versions: { prompt_version: sys.prompt_version, model_version: sys.model_version, provider_model_version: providerVersion || null, rule_set_versions: sys.rule_set_versions }, metrics, pass, ran_by: ctx.actor.id, ran_at: ranOn, report_document_id: str(i, "report_document_id") || `RPT_AI_EVAL_${sysId}_${str(i, "version")}`, drift: drift?.drift ?? false }, ctx.actor, ctx.now).data;
      if (str(i, "version") === String(sys.version)) rt.store.put("ai_systems", sysId, { eval_pass: pass, eval_run_id: id, last_eval_at: ranOn }, ctx.actor, ctx.now);
      sysEvent(ctx, "ai_eval.run.completed", sysId, { run_id: id, ai_system_id: sysId, suite: str(i, "suite"), version: str(i, "version"), pass, eval_suite_passed: pass, inventory_updated: true, prompt_version: sys.prompt_version, model_version: sys.model_version });
      if (!drift?.drift) return { ...data, state: systemState(rt.store.get("ai_systems", sysId)!.data), drift: null };
      // T8: golden-set drift → high-risk decision kinds restricted within the 2-BD review window; silent provider version change = 19.3 vendor-SLA breach
      const worst = [...drift.deltas].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0]!;
      const alertId = `${sysId}:${ranOn}:${worst.metric}`;
      rt.store.put("drift_alerts", alertId, { alert_id: alertId, ai_system_id: sysId, metric: worst.metric, deltas: drift.deltas, detected_at: ranOn, review_due: drift.review_due, disposition: null, restricted_decision_kinds: drift.restricted_decision_kinds }, ctx.actor, ctx.now);
      const detected = sysEvent(ctx, "ai.monitor.drift_detected", sysId, { alert_id: alertId, metric: worst.metric, ai_system_id: sysId, deltas: drift.deltas, detected_at: ranOn, review_due: drift.review_due, provider_model_version: providerVersion || null, silent_provider_update: silent });
      if (drift.restricted_decision_kinds.length) { rt.store.put("ai_systems", sysId, { restricted_decision_kinds: drift.restricted_decision_kinds, status: "restricted" }, ctx.actor, ctx.now); sysEvent(ctx, "ai_system.restricted", sysId, { ai_system_id: sysId, decision_kinds: drift.restricted_decision_kinds, restricted_decision_kinds: drift.restricted_decision_kinds, reason: `golden-set drift on ${worst.metric}`, alert_id: alertId }); }
      if (drift.vendor_sla_breach) ctx.events.append({ type: "vendor.sla_breach.logged", loanId: ctx.loanId, aggregate: { kind: "vendors", id: String(sys.vendor_id ?? "model_provider") }, actor: ctx.actor, causationId: detected.id, payload: { vendor_id: String(sys.vendor_id ?? "model_provider"), ai_system_id: sysId, clause: "VERSION_CHANGE_NOTICE", provider_model_version: providerVersion, detected_at: ranOn, origination: true } });
      const esc = rt.escalations.open({ kind: "sev1", payload: { reason: "drift_detected", alert_id: alertId, ai_system_id: sysId, metric: worst.metric, review_due: drift.review_due, restricted_decision_kinds: drift.restricted_decision_kinds, engineering_owner: true } }, ctx.actor);
      return { ...data, drift: { ...drift, alert_id: alertId, escalation_id: esc.id, timer: "SM_O122_DRIFT_ALERT_REVIEW_2BD", vendor_sla_breach_logged: drift.vendor_sla_breach }, state: "restricted" };
};
  // ---- 19.4's four bias tests as the pre-deploy / quarterly suite; the rule-9 leakage test on agent-run manifests (T7)
const biasSuite: Handler = (i, ctx, rt) => {
      const op = str(i, "op") || "suite";
      if (op === "leakage") {
        need(i, "run_id", "ai_system_id", "decision_kind", "inputs_manifest"); const sysId = str(i, "ai_system_id"); const sys = rt.store.get("ai_systems", sysId)?.data ?? null;
        const manifest = i.inputs_manifest as Record<string, unknown> | readonly string[];
        const r = leakageTest({ run_id: str(i, "run_id"), ai_system_id: sysId, decision_kind: str(i, "decision_kind") as DecisionKind, inputs_manifest: manifest });
        rt.store.put("agent_runs", str(i, "run_id"), { run_id: str(i, "run_id"), ai_system_id: sysId, decision_kind: str(i, "decision_kind"), inputs_manifest: manifest, leakage_pass: r.pass, leakage_fields: r.fields, quarantined: r.quarantine }, ctx.actor, ctx.now);
        ctx.events.append({ type: "ai.bias_test.attribute_leakage", loanId: ctx.loanId, aggregate: { kind: "agent_runs", id: str(i, "run_id") }, actor: ctx.actor, payload: { run_id: str(i, "run_id"), ai_system_id: sysId, pass: r.pass, fields: r.fields, test_kind: "attribute_leakage", origination: true } });
        if (r.pass) return { ...r, escalation_id: null };
        ctx.events.append({ type: "agent_run.quarantined", loanId: ctx.loanId, aggregate: { kind: "agent_runs", id: str(i, "run_id") }, actor: ctx.actor, payload: { run_id: str(i, "run_id"), ai_system_id: sysId, fields: r.fields, reason: "proxy/restricted field in a decision-agent inputs manifest (rule 9)", origination: true } });
        const kinds = [...new Set([...strings(sys?.restricted_decision_kinds), ...r.restrict!.decision_kinds])];
        if (sys) rt.store.put("ai_systems", sysId, { restricted_decision_kinds: kinds, status: "restricted" }, ctx.actor, ctx.now);
        sysEvent(ctx, "ai_system.restricted", sysId, { ai_system_id: sysId, decision_kinds: r.restrict!.decision_kinds, restricted_decision_kinds: kinds, reason: `attribute leakage on run ${str(i, "run_id")}: ${r.fields.join(", ")} — restricted until re-tested` });
        ctx.events.append({ type: "fair_lending.review.opened", loanId: ctx.loanId, aggregate: { kind: "agent_runs", id: str(i, "run_id") }, actor: ctx.actor, payload: { kind: "attribute_leakage", severity: "sev1", run_id: str(i, "run_id"), ai_system_id: sysId, fields: r.fields, origination: true } });
        const esc = rt.escalations.open({ kind: "sev1", payload: { reason: "attribute_leakage", run_id: str(i, "run_id"), ai_system_id: sysId, fields: r.fields, restricted_decision_kinds: kinds } }, ctx.actor);
        return { ...r, restricted_decision_kinds: kinds, escalation_id: esc.id, review: { severity: "sev1", opened: true } };
      }
      need(i, "ai_system_id", "scope", "tests"); const sysId = str(i, "ai_system_id"); const sys = row(rt, "ai_systems", sysId);
      const t = i.tests as Record<string, unknown>;
      const tests: BiasTests = { leakage_clean: t.leakage_clean === true, counterfactual_flip_rate: Number(t.counterfactual_flip_rate ?? 1), directional_shift: t.directional_shift === true, outcome_parity_ok: t.outcome_parity_ok === true, explanation_consistent: t.explanation_consistent === true };
      const r = runBiasSuite(ctx.events, { ai_system_id: sysId, model_version: String(sys.model_version ?? ""), prompt_version: String(sys.prompt_version ?? ""), scope: str(i, "scope") as "pre_deploy" | "production", ran_on: i.ran_on ? D(str(i, "ran_on")) : today(ctx), dataset_id: str(i, "dataset_id") || `golden-${sysId}`, ...(i.dataset_cases !== undefined ? { dataset_cases: num(i, "dataset_cases") } : {}), tests }, ctx.actor);
      if (str(i, "scope") === "pre_deploy") rt.store.put("ai_systems", sysId, { bias_tests_pass: r.pass, bias_tests_at: ctx.now }, ctx.actor, ctx.now);
      else if (!r.pass) { const kinds = strings(sys.decision_kinds).filter((k) => (HIGH_RISK_DECISION_KINDS as readonly string[]).includes(k)); rt.store.put("ai_systems", sysId, { restricted_decision_kinds: kinds, status: "restricted" }, ctx.actor, ctx.now); sysEvent(ctx, "ai_system.restricted", sysId, { ai_system_id: sysId, decision_kinds: kinds, restricted_decision_kinds: kinds, reason: `quarterly bias test failed: ${(r.failures as BiasTestKind[]).join(", ")}` }); }
      return { pass: r.pass, failures: r.failures, passed_tests: r.passed_tests, deploy: r.deploy, review: r.review, state: systemState(rt.store.get("ai_systems", sysId)!.data) };
};
  // ---- rules 5–7: monthly / quarterly outcome monitoring, material-finding reviews, complaint triage, reviewer metrics, decision records
const monitorRun: Handler = (i, ctx, rt) => {
      const op = str(i, "op") || "run";
      switch (op) {
        case "run": {
          need(i, "scope", "period", "populations"); const scope = str(i, "scope"), period = str(i, "period"); const runOn = i.run_on ? D(str(i, "run_on")) : today(ctx);
          const kind = str(i, "kind") || "monthly"; const controls = flag(i, "controls") || kind === "regression";
          const pops = list<Record<string, unknown>>(i.populations); if (!pops.length) throw new RangeError("populations[] is required");
          const runId = str(i, "run_id") || `${scope}:${period}:${kind}`;
          const findings = pops.map((p, k) => {
            const input: DisparityInput = { n_group: Number(p.n_group), events_group: Number(p.events_group), n_comparison: Number(p.n_comparison), events_comparison: Number(p.events_comparison), adjusted_or: p.adjusted_or === undefined ? null : Number(p.adjusted_or), adjusted_or_ci: Array.isArray(p.adjusted_or_ci) ? [Number(p.adjusted_or_ci[0]), Number(p.adjusted_or_ci[1])] : null, adverse_direction: (p.adverse_direction as "lower" | "higher" | undefined) ?? (String(p.metric_code ?? "").match(/COUNTEROFFER|DENIAL|HOLD|COMPLAINT|DAYS|CONDITIONS|SPREAD|PRICE|REQUEST/) ? "higher" : "lower") };
            if ([input.n_group, input.events_group, input.n_comparison, input.events_comparison].some((n) => Number.isNaN(n))) throw new RangeError("each population needs n_group, events_group, n_comparison, events_comparison");
            const r = scope === "pricing_exceptions" ? pricingExceptionReview({ exceptions: list(p.exceptions), counts: input }).result : disparityTest(input);
            const findingId = `${runId}:${String(p.metric_code ?? "METRIC")}:${String(p.dimension ?? "dimension")}:${k}`;
            const flagged_at = r.flag === "material" ? reviewOpensOn(runOn) : runOn;
            const data = rt.store.put("fair_lending_findings", findingId, { finding_id: findingId, run_id: runId, metric_code: String(p.metric_code ?? "METRIC"), dimension: String(p.dimension ?? "ethnicity"), group: String(p.group ?? "group"), comparison_group: String(p.comparison_group ?? "comparison"), ...r, flagged_at, ai_vs_human_split: p.ai_vs_human_split ?? null, window_months: Number(p.window_months ?? 1), reason_mix: scope === "pricing_exceptions" ? pricingExceptionReview({ exceptions: list(p.exceptions), counts: input }).reason_mix : null, all_exceptions_coded: scope === "pricing_exceptions" ? pricingExceptionReview({ exceptions: list(p.exceptions), counts: input }).all_coded : null, pooled_to_12m: scope === "pricing_exceptions" && r.screen_fails && !r.material }, ctx.actor, ctx.now).data;
            return data;
          });
          const status = findings.some((f) => f.flag === "material") ? "flagged" : "computed";
          const run = rt.store.put("fair_lending_runs", runId, { run_id: runId, scope, kind, controls, period, period_start: str(i, "period_start") || null, period_end: str(i, "period_end") || null, population_rule: str(i, "population_rule") || (scope === "underwriting_outcomes" ? "hmda_records.action_taken in (1,2,3,4,5) and action_taken_date in period" : null), method_version: str(i, "method_version") || "METH-FL-02 v1", dataset_hash: str(i, "dataset_hash") || null, population_counts: findings.map((f) => ({ metric_code: f.metric_code, n_group: f.n_group, n_comparison: f.n_comparison })), demographic_source: str(i, "demographic_source") || "applicant_demographics", status, ran_at: runOn, human_only: flag(i, "ai_off"), retention: "ai_governance_7y" }, ctx.actor, ctx.now).data;
          const done = new Set(rt.store.list("fair_lending_runs", (d) => d.period === period && d.kind === "monthly").map((r) => String(r.data.scope)));
          const all_scopes = kind === "monthly" && MONTHLY_SCOPES.every((s) => done.has(s));
          const completed = ctx.events.append({ type: "fair_lending.run.completed", loanId: ctx.loanId, aggregate: { kind: "fair_lending_runs", id: runId }, actor: ctx.actor, payload: { run_id: runId, scope, period, kind, controls, all_scopes, status, ran_at: runOn, findings: findings.map((f) => ({ finding_id: f.finding_id, metric_code: f.metric_code, flag: f.flag })), origination: true } });
          const reviews: Record<string, unknown>[] = [];
          for (const f of findings) {
            ctx.events.append({ type: "fair_lending.finding.flagged", loanId: ctx.loanId, aggregate: { kind: "fair_lending_findings", id: String(f.finding_id) }, actor: ctx.actor, causationId: completed.id, payload: { finding_id: f.finding_id, run_id: runId, metric_code: f.metric_code, dimension: f.dimension, flag: f.flag, air: f.air, z: f.z, p_value: f.p_value, diff_pp: f.diff_pp, adjusted_or: f.adjusted_or, flagged_at: f.flagged_at, origination: true } });
            if (f.flag !== "material") continue;
            const opened = D(String(f.flagged_at)); const due = reviewDue(opened);
            const review = rt.store.put("fair_lending_reviews", String(f.finding_id), { finding_id: f.finding_id, run_id: runId, opened_at: opened, due_on: due, reviewer: null, root_cause: null, legitimate_justification: null, lda_search_id: null, corrective_actions: [], status: "open", closed_at: null, privilege_marker: true, system_state: "monitored{remediation}", ai_system_id: str(i, "ai_system_id") || null }, ctx.actor, ctx.now).data;
            ctx.events.append({ type: "fair_lending.review.opened", loanId: ctx.loanId, aggregate: { kind: "fair_lending_findings", id: String(f.finding_id) }, actor: ctx.actor, payload: { finding_id: f.finding_id, opened_at: opened, due_on: due, timer: "SM_O122_FAIR_LENDING_REVIEW_30D", origination: true } });
            const esc = rt.escalations.open({ kind: "officer", payload: { reason: "material_fair_lending_finding", finding_id: f.finding_id, metric_code: f.metric_code, due_on: due, both_entities: true, counsel_direction: "attorney" } }, ctx.actor);
            reviews.push({ ...review, escalation_id: esc.id });
          }
          return { ...run, findings, reviews, all_scopes, timer: kind === "regression" ? "SM_O122_FAIR_LENDING_REGRESSION_QUARTERLY" : scope === "pricing_exceptions" ? "SM_O122_PRICING_EXCEPTION_REVIEW_MONTHLY" : "SM_O122_FAIR_LENDING_MONITOR_MONTHLY" };
        }
        case "close_review": {
          need(i, "finding_id"); const id = str(i, "finding_id"); const cur = row(rt, "fair_lending_reviews", id);
          const actions = [...list<unknown>(cur.corrective_actions), ...list<unknown>(i.corrective_actions)];
          const just = str(i, "legitimate_justification") || (cur.legitimate_justification as string | null) || null;
          const may = reviewMayClose({ corrective_actions: actions, legitimate_justification: just, officer_disposition: hasRole(ctx.actor, ["officer"]) });
          if (!may.ok) throw new RangeError(may.reason ?? "closure refused");
          const data = rt.store.put("fair_lending_reviews", id, { reviewer: ctx.actor.id, root_cause: str(i, "root_cause") || cur.root_cause || null, legitimate_justification: just, lda_search_id: str(i, "lda_search_id") || cur.lda_search_id || null, corrective_actions: actions, status: "closed", closed_at: ctx.now, disposition: actions.length ? "corrective_action" : "legitimate_justification" }, ctx.actor, ctx.now).data;
          ctx.events.append({ type: "fair_lending.review.closed", loanId: ctx.loanId, aggregate: { kind: "fair_lending_findings", id }, actor: ctx.actor, payload: { finding_id: id, disposition: data.disposition, corrective_actions: actions, legitimate_justification: just, closed_by: ctx.actor.id, origination: true } });
          return data;
        }
        case "complaint_intake": {
          need(i, "case_id", "opened_at"); const caseId = str(i, "case_id");
          const data = rt.store.put("fair_lending_complaints", caseId, { case_id: caseId, opened_at: str(i, "opened_at"), application_id: str(i, "application_id") || null, allegation: str(i, "allegation") || "discrimination", disposition: null, triaged_at: null }, ctx.actor, ctx.now).data;
          ctx.events.append({ type: "fair_lending.complaint.received", loanId: ctx.loanId, aggregate: { kind: "cases", id: caseId }, actor: ctx.actor, payload: { case_id: caseId, opened_at: str(i, "opened_at"), fair_lending_flag: true, origination: true } });
          return { ...data, timer: "SM_O122_COMPLAINT_FL_TRIAGE_5BD" };
        }
        case "complaint_triage": {
          need(i, "case_id", "disposition"); const caseId = str(i, "case_id"); row(rt, "fair_lending_complaints", caseId);
          const disp = str(i, "disposition"); if (!["finding_linked", "decision_rereview", "no_pattern"].includes(disp)) throw new RangeError("disposition must be finding_linked, decision_rereview or no_pattern");
          if (disp === "finding_linked") need(i, "finding_id");
          const data = rt.store.put("fair_lending_complaints", caseId, { disposition: disp, finding_id: str(i, "finding_id") || null, rereview_by_different_reviewer: disp === "decision_rereview", triaged_at: ctx.now }, ctx.actor, ctx.now).data;
          ctx.events.append({ type: "fair_lending.complaint.triaged", loanId: ctx.loanId, aggregate: { kind: "cases", id: caseId }, actor: ctx.actor, payload: { case_id: caseId, disposition: disp, finding_id: str(i, "finding_id") || null, origination: true } });
          return data;
        }
        case "reviewer_metrics": {
          need(i, "reviewer_id", "recommendations", "approved", "median_review_seconds", "ai_system_id"); const sysId = str(i, "ai_system_id"); row(rt, "ai_systems", sysId);
          const r = reviewerOverrideTest({ reviewer_id: str(i, "reviewer_id"), recommendations: num(i, "recommendations"), approved: num(i, "approved"), median_review_seconds: num(i, "median_review_seconds") });
          const period = str(i, "period") || ctx.now.slice(0, 7);
          rt.store.put("fair_lending_findings", `${sysId}:${period}:UW_REVIEWER_OVERRIDE_RATE:${str(i, "reviewer_id")}`, { finding_id: `${sysId}:${period}:UW_REVIEWER_OVERRIDE_RATE:${str(i, "reviewer_id")}`, run_id: `reviewer:${period}`, metric_code: r.metric_code, dimension: "reviewer", group: str(i, "reviewer_id"), comparison_group: "all_reviewers", n_group: num(i, "recommendations"), rate_group: 1 - r.override_rate, median_review_seconds: num(i, "median_review_seconds"), flag: r.flagged ? "material" : "none", flagged_at: today(ctx) }, ctx.actor, ctx.now);
          if (r.flagged) { rt.store.put("ai_systems", sysId, { ca_substantially_replaces_human: true, ca_substantially_replaces_human_reason: `reviewer ${str(i, "reviewer_id")} rubber-stamping (${period}) until retraining is evidenced`, pack_exceptions: [...strings(row(rt, "ai_systems", sysId).pack_exceptions), `reviewer ${str(i, "reviewer_id")}: ${period} approval rate 100 % with median review ${num(i, "median_review_seconds")} s — retraining`] }, ctx.actor, ctx.now); sysEvent(ctx, "ai_system.human_involvement.flagged", sysId, { ai_system_id: sysId, reviewer_id: str(i, "reviewer_id"), period, ca_substantially_replaces_human: true, actions: r.actions }); }
          return { ...r, period, ai_system_id: sysId, partner_notified_in_pack: r.flagged };
        }
        case "decision_record": {
          need(i, "decision_kind", "principal_factors", "inputs_manifest", "rationale");
          const rec = decisionRecord({ ai_off: flag(i, "ai_off"), decision_kind: str(i, "decision_kind") as DecisionKind, principal_factors: strings(i.principal_factors), reviewer_action: (i.reviewer_action as "approved" | "modified" | "rejected" | undefined) ?? null, inputs_manifest: strings(i.inputs_manifest), rationale: str(i, "rationale") });
          if (!rec.ok) throw new RangeError(`decision record refused: ${rec.refusals.join("; ")}`);
          const id = str(i, "decision_id") || `${str(i, "application_id") || ctx.applicationId || "app"}:${str(i, "decision_kind")}:${ctx.now}`;
          const data = rt.store.put("agent_decisions", id, { id, application_id: str(i, "application_id") || ctx.applicationId || null, agent: flag(i, "ai_off") ? "human_path" : str(i, "agent") || ctx.actor.id, decision_kind: str(i, "decision_kind"), outcome: str(i, "outcome") || null, inputs_manifest: strings(i.inputs_manifest), rule_set_versions: i.rule_set_versions ?? {}, model_version: flag(i, "ai_off") ? null : str(i, "model_version") || null, prompt_version: flag(i, "ai_off") ? null : str(i, "prompt_version") || null, principal_factors: strings(i.principal_factors), rationale: str(i, "rationale"), confidence: i.confidence ?? null, reviewer_id: str(i, "reviewer_id") || null, reviewer_action: i.reviewer_action ?? null, co_material_influence: rec.co_material_influence, human_involvement_level: rec.human_involvement_level, retention_class: rec.retention_classes }, ctx.actor, ctx.now).data;
          ctx.decide({ agent: String(data.agent), action: `decision:${str(i, "decision_kind")}`, rationale: str(i, "rationale"), ruleSetVersion: str(i, "rule_set_version") || "uw.reasons v1.5", ...(data.application_id ? { applicationId: String(data.application_id) } : {}), subject: { kind: "agent_decisions", id }, modelVersion: (data.model_version as string | null), promptVersion: (data.prompt_version as string | null) });
          ctx.events.append({ type: "agent_decision.recorded", loanId: ctx.loanId, ...(data.application_id ? { applicationId: String(data.application_id) } : {}), aggregate: { kind: "agent_decisions", id }, actor: ctx.actor, payload: { decision_id: id, decision_kind: str(i, "decision_kind"), human_involvement_level: rec.human_involvement_level, co_material_influence: rec.co_material_influence, reviewer_action: i.reviewer_action ?? null, origination: true } });
          return data;
        }
        default: throw new RangeError(`monitor.run op ${op} is not one of run/close_review/complaint_intake/complaint_triage/reviewer_metrics/decision_record`);
      }
};

  // ---- the statistics alone (rule 5 / 19.4 rule 7): AIR, z, p and the flag for one metric × dimension
const monitorTest: Handler = (i) => {
      need(i, "n_group", "events_group", "n_comparison", "events_comparison");
      return { metric: str(i, "metric") || null, dimension: str(i, "dimension") || null, ...disparityTest({ n_group: num(i, "n_group"), events_group: num(i, "events_group"), n_comparison: num(i, "n_comparison"), events_comparison: num(i, "events_comparison"), adjusted_or: i.adjusted_or === undefined ? null : num(i, "adjusted_or"), adverse_direction: (i.adverse_direction as "lower" | "higher" | undefined) ?? "lower" }) };
};
  // ---- rule 4: monthly reason-accuracy replay (T4)
const reasonsReplay: Handler = (i, ctx, rt) => {
      need(i, "period", "population", "replays"); const period = str(i, "period"); const replays = list<ReasonReplay>(i.replays).map((r) => ({ adverse_action_id: String(r.adverse_action_id), issued_reasons: strings(r.issued_reasons), replayed_reasons: strings(r.replayed_reasons), ...(r.application_id ? { application_id: String(r.application_id) } : {}) }));
      for (const r of replays) for (const t of [...r.issued_reasons, ...r.replayed_reasons]) if (!rationaleGuard(t).ok) throw new RangeError(`reason text cites a prohibited basis: ${t}`);
      const acc = reasonAccuracy({ population: num(i, "population"), replays, sample_pct: num(i, "sample_pct") === 100 ? 100 : null });
      const foundOn = i.ran_on ? D(str(i, "ran_on")) : today(ctx);
      const corrections = acc.mismatches.map((m) => ({ adverse_action_id: m.adverse_action_id, application_id: m.application_id ?? null, corrected_statement_due: correctedStatementDue(foundOn), path: "21.6 corrected statement of reasons" }));
      const id = `reason_accuracy:${period}`;
      const data = rt.store.put("fair_lending_runs", id, { run_id: id, scope: "reason_accuracy", kind: "monthly", period, population_counts: { population: acc.population, sample: acc.sample, matches: acc.matches }, method_version: "rule replay + second independent model pass", status: acc.pass ? "closed" : "flagged", ran_at: foundOn, accuracy: acc.accuracy, corrective_action_required: acc.corrective_action_required, full_rereview_required: acc.full_rereview_required, next_month_sample_pct: acc.next_month_sample_pct, corrections, retention: "ai_governance_7y" }, ctx.actor, ctx.now).data;
      rt.store.put("fair_lending_findings", `${id}:RA_REASON_ACCURACY`, { finding_id: `${id}:RA_REASON_ACCURACY`, run_id: id, metric_code: acc.metric_code, dimension: "all", group: "sample", comparison_group: "issued_notices", n_group: acc.sample, rate_group: acc.accuracy, flag: acc.pass ? "none" : acc.full_rereview_required ? "material" : "significant", flagged_at: foundOn }, ctx.actor, ctx.now);
      ctx.events.append({ type: "reason_accuracy.sample.completed", loanId: ctx.loanId, aggregate: { kind: "fair_lending_runs", id }, actor: ctx.actor, payload: { run_id: id, period, metric_code: acc.metric_code, population: acc.population, sample: acc.sample, matches: acc.matches, accuracy: acc.accuracy, pass: acc.pass, corrective_action_required: acc.corrective_action_required, next_month_sample_pct: acc.next_month_sample_pct, origination: true } });
      for (const c of corrections) ctx.events.append({ type: "reason_accuracy.correction.required", loanId: ctx.loanId, ...(c.application_id ? { applicationId: c.application_id } : {}), aggregate: { kind: "adverse_actions", id: c.adverse_action_id }, actor: ctx.actor, payload: { ...c, period, origination: true } });
      const escalations: string[] = [];
      if (acc.corrective_action_required) escalations.push(rt.escalations.open({ kind: acc.full_rereview_required ? "sev1" : "officer", payload: { reason: "reason_accuracy_below_threshold", period, accuracy: acc.accuracy, corrective_action: "rule-set change versioned, approved by officer and re-gated", next_month_sample_pct: 100 } }, ctx.actor).id);
      if (acc.full_rereview_required) escalations.push(rt.escalations.open({ kind: "underwriting_reviewer", payload: { reason: "100 % re-review of the month's adverse-action notices", period } }, ctx.actor).id);
      return { ...data, mismatches: acc.mismatches, escalation_ids: escalations, timer: "SM_O122_REASON_ACCURACY_SAMPLE_MONTHLY" };
};
  // ---- rule 8: less-discriminatory-alternative search (recorded whether or not a change is made)
const ldaSearch: Handler = (i, ctx, rt) => {
      need(i, "subject", "trigger", "alternatives"); const alts = list<{ description: string; performance_delta: number; disparity_delta: number }>(i.alternatives).map((a) => ({ description: String(a.description), performance_delta: Number(a.performance_delta), disparity_delta: Number(a.disparity_delta) }));
      const sel = ldaSelect(alts, i.max_performance_loss === undefined ? 0.01 : num(i, "max_performance_loss"));
      const id = str(i, "search_id") || `lda:${str(i, "subject")}:${ctx.now.slice(0, 10)}`;
      const data = rt.store.put("lda_searches", id, { search_id: id, subject: str(i, "subject"), trigger: str(i, "trigger"), alternatives: alts, selected: sel.selected, rationale: sel.rationale, approved_by: null, completed_at: ctx.now, document_id: `DOC_LDA_SEARCH_${id}`, change_made: false, retention: "ai_governance_7y" }, ctx.actor, ctx.now).data;
      if (str(i, "finding_id") && rt.store.get("fair_lending_reviews", str(i, "finding_id"))) rt.store.put("fair_lending_reviews", str(i, "finding_id"), { lda_search_id: id }, ctx.actor, ctx.now);
      ctx.events.append({ type: "lda.search.completed", loanId: ctx.loanId, aggregate: { kind: "lda_searches", id }, actor: ctx.actor, payload: { search_id: id, subject: str(i, "subject"), trigger: str(i, "trigger"), selected: sel.selected, finding_id: str(i, "finding_id") || null, origination: true } });
      return { ...data, escalation: sel.selected ? { kind: "officer", reason: "approve the selected alternative as a versioned rule-set change (re-gated)" } : null };
};
  // ---- drift alerts: dispositions within 2 BD; a second unreviewed alert auto-restricts
const driftWatch: Handler = (i, ctx, rt) => {
      const op = str(i, "op") || "sweep";
      if (op === "dispose") {
        need(i, "alert_id", "disposition"); const id = str(i, "alert_id"); const cur = row(rt, "drift_alerts", id); const disp = str(i, "disposition");
        if (!["benign", "restrict", "roll_back"].includes(disp)) throw new RangeError("disposition must be benign, restrict or roll_back");
        const data = rt.store.put("drift_alerts", id, { disposition: disp, disposed_at: ctx.now, disposed_by: ctx.actor.id }, ctx.actor, ctx.now).data;
        sysEvent(ctx, "ai.monitor.drift_disposed", String(cur.ai_system_id), { alert_id: id, ai_system_id: cur.ai_system_id, metric: cur.metric, disposition: disp, disposed_at: ctx.now });
        if (disp === "benign") { const sys = row(rt, "ai_systems", String(cur.ai_system_id)); rt.store.put("ai_systems", String(cur.ai_system_id), { restricted_decision_kinds: [], status: sys.deployed_at ? "deployed" : String(sys.status ?? "registered") }, ctx.actor, ctx.now); sysEvent(ctx, "ai_system.unrestricted", String(cur.ai_system_id), { ai_system_id: cur.ai_system_id, decision_kinds: cur.restricted_decision_kinds, restricted_decision_kinds: [], reason: "drift alert disposed benign", eval_run_id: null }); }
        return data;
      }
      const open = rt.store.list("drift_alerts", (d) => !d.disposition).map((r) => r.data);
      const bySystem = new Map<string, Record<string, unknown>[]>();
      for (const a of open) { const k = String(a.ai_system_id); bySystem.set(k, [...(bySystem.get(k) ?? []), a]); }
      const auto: string[] = [];
      for (const [sysId, alerts] of bySystem) if (driftAutoRestrict(alerts.length)) { const sys = rt.store.get("ai_systems", sysId)?.data; if (!sys) continue; const kinds = strings(sys.decision_kinds).filter((k) => (HIGH_RISK_DECISION_KINDS as readonly string[]).includes(k)); if (!kinds.length || String(sys.status) === "restricted") continue; rt.store.put("ai_systems", sysId, { restricted_decision_kinds: kinds, status: "restricted" }, ctx.actor, ctx.now); sysEvent(ctx, "ai_system.restricted", sysId, { ai_system_id: sysId, decision_kinds: kinds, restricted_decision_kinds: kinds, reason: "second unreviewed drift alert (auto-restrict)" }); auto.push(sysId); }
      return { open_alerts: open, auto_restricted: auto };
};
  // ---- rule 12: the quarterly governance evidence pack; T10's LL-2026-04 disclosure response compiled from the latest pack
const packCompile: Handler = (i, ctx, rt) => {
      const op = str(i, "op") || "quarterly";
      const inventory = rt.store.list("ai_systems").map((r) => r.data);
      if (op === "fnma_disclosure") {
        need(i, "request_id", "received_on"); const received = date(i, "received_on");
        const packs = rt.store.list("ai_governance_packs").map((r) => r.data as unknown as Pack).sort((a, b) => (a.issued_on < b.issued_on ? 1 : -1));
        const pkg = fnmaDisclosurePackage({ request_id: str(i, "request_id"), received_on: received, pack: packs[0] ?? null, inventory: inventory.map((s) => ({ id: String(s.id), agent_package: String(s.agent_package), ...(s.purpose ? { purpose: String(s.purpose) } : {}), decision_kinds: strings(s.decision_kinds), sr11_7_model_class: String(s.sr11_7_model_class ?? "llm_agent"), human_touchpoints: strings(s.human_touchpoints).length ? strings(s.human_touchpoints) : ["underwriting_reviewer", "mlo_of_record"] })) });
        const data = rt.store.put("fnma_disclosure_responses", str(i, "request_id"), { request_id: str(i, "request_id"), received_on: received, due_on: pkg.due, timer: pkg.timer, response: pkg.response, status: "compiled", compiled_at: ctx.now }, ctx.actor, ctx.now).data;
        const esc = rt.escalations.open({ kind: "officer", payload: { reason: pkg.officer_task.reason, request_id: str(i, "request_id"), due_on: pkg.due, timer: pkg.timer, source_pack: pkg.response.source_pack, send_via: "19.3 fnma_notices.recordSent{kind=ll2026_04_disclosure}" } }, ctx.actor);
        ctx.events.append({ type: "fnma.disclosure.package.compiled", loanId: ctx.loanId, aggregate: { kind: "fnma_information_requests", id: str(i, "request_id") }, actor: ctx.actor, payload: { request_id: str(i, "request_id"), kind: "ll2026_04_disclosure", due_on: pkg.due, source_pack: pkg.response.source_pack, escalation_id: esc.id, origination: true } });
        return { ...data, officer_task: { ...pkg.officer_task, escalation_id: esc.id } };
      }
      need(i, "period"); const period = str(i, "period"); const issuedOn = i.issued_on ? D(str(i, "issued_on")) : today(ctx);
      const exceptions: string[] = [];
      if (str(i, "policy_last_reviewed_on")) { const p = policyReviewStatus({ last_reviewed_on: date(i, "policy_last_reviewed_on"), today: issuedOn, reviewed_since: flag(i, "policy_reviewed_since") }); if (p.pack_exception) exceptions.push(p.pack_exception); }
      for (const s of inventory) for (const x of strings(s.pack_exceptions)) exceptions.push(`${s.id}: ${x}`);
      for (const s of inventory) if (s.next_assessment_due && String(s.next_assessment_due) < issuedOn) exceptions.push(`${s.id}: SM_O122_AI_ASSESSMENT_ANNUAL_365 overdue (due ${String(s.next_assessment_due)})`);
      const contents = { inventory_export: inventory.map((s) => ({ id: s.id, version: s.version, agent_package: s.agent_package, decision_kinds: s.decision_kinds, risk_tier: s.risk_tier, status: s.status, ca_substantially_replaces_human: s.ca_substantially_replaces_human, human_touchpoints: strings(s.human_touchpoints) })), policy_and_review_minutes: i.policy_minutes ?? null, assessments: rt.store.list("ai_impact_assessments").map((r) => r.data), evaluation_summaries: rt.store.list("ai_eval_runs").map((r) => ({ run_id: r.data.run_id, ai_system_id: r.data.ai_system_id, pass: r.data.pass })), bias_test_summaries: ctx.events.ofType("ai.bias_tests.completed").map((e) => ({ ai_system_id: e.payload.ai_system_id, scope: e.payload.scope, pass: e.payload.pass })), monitoring_runs_and_findings: rt.store.list("fair_lending_runs").map((r) => r.data), findings: rt.store.list("fair_lending_findings").map((r) => ({ finding_id: r.data.finding_id, metric_code: r.data.metric_code, flag: r.data.flag })), reviews: rt.store.list("fair_lending_reviews").map((r) => r.data), reason_accuracy_results: rt.store.list("fair_lending_runs", (d) => d.scope === "reason_accuracy").map((r) => ({ period: r.data.period, accuracy: r.data.accuracy })), lda_searches: rt.store.list("lda_searches").map((r) => r.data), decision_record_samples: rt.store.list("agent_decisions").slice(0, 25).map((r) => ({ decision_kind: r.data.decision_kind, human_involvement_level: r.data.human_involvement_level, reviewer_action: r.data.reviewer_action })), colorado_cards_notices_statistics: { cards: rt.store.list("system_cards").map((r) => ({ ai_system_id: r.data.ai_system_id, version: r.data.version, acknowledged_at: r.data.acknowledged_at })), rights_requests: rt.store.list("consumer_ai_rights_requests").length, explanations_reported_from: "21.6 adverse_actions.co_admt" }, california_artifacts: rt.store.get("ca_admt_readiness", "CA")?.data ?? null, vendor_attestations: i.vendor_attestations ?? [], drift_alerts: rt.store.list("drift_alerts").map((r) => r.data), reviewer_flags: rt.store.list("fair_lending_findings", (d) => d.metric_code === "UW_REVIEWER_OVERRIDE_RATE" && d.flag === "material").map((r) => r.data.group) };
      const data = rt.store.put("ai_governance_packs", period, { period, issued_on: issuedOn, contents, exceptions, document_code: `PACK_AI_GOVERNANCE_${period}`, recipient: "partner", retention: "ai_governance_7y" }, ctx.actor, ctx.now).data;
      ctx.events.append({ type: "ai_governance.pack.issued", loanId: ctx.loanId, aggregate: { kind: "ai_governance_packs", id: period }, actor: ctx.actor, payload: { period, issued_on: issuedOn, exceptions, document_code: data.document_code, origination: true } });
      return data;
};

  // ---- rule 11: Colorado developer documentation (DOC_AI_SYSTEM_CARD) and material-update notices
const cardsRender: Handler = (i, ctx, rt) => {
      const op = str(i, "op") || "card";
      need(i, "ai_system_id"); const sysId = str(i, "ai_system_id"); const sys = row(rt, "ai_systems", sysId);
      if (op === "material_update") {
        need(i, "version", "notified_at");
        const data = rt.store.put("ai_systems", sysId, { co_material_update_notified_at: str(i, "notified_at") }, ctx.actor, ctx.now).data;
        sysEvent(ctx, "co_admt.material_update.notified", sysId, { ai_system_id: sysId, version: str(i, "version"), notified_at: str(i, "notified_at"), deployer: "partner", card_document_id: str(i, "document_id") || null });
        return { ...data, timer: "CO_SB26_189_1702_MATERIAL_UPDATE_NOTICE" };
      }
      if (op === "acknowledge") {
        need(i, "acknowledged_at"); const cardId = `${sysId}:${String(sys.version)}`; const card = rt.store.get("system_cards", cardId)?.data; if (!card || !card.delivered_at) throw new RangeError(`card ${cardId} has not been delivered`);
        rt.store.put("system_cards", cardId, { acknowledged_at: str(i, "acknowledged_at") }, ctx.actor, ctx.now);
        const data = rt.store.put("ai_systems", sysId, { co_docs_acknowledged_at: str(i, "acknowledged_at") }, ctx.actor, ctx.now).data;
        sysEvent(ctx, "co_admt.developer_docs.delivered", sysId, { ai_system_id: sysId, version: sys.version, delivered_at: card.delivered_at, acknowledged: true, acknowledged_at: str(i, "acknowledged_at"), document_id: card.document_code });
        return { ...data, card: rt.store.get("system_cards", cardId)!.data };
      }
      need(i, "intended_uses", "known_limitations", "instructions_for_use_and_human_review");
      const card = systemCard({ ai_system_id: sysId, version: String(sys.version), model_class: String(sys.sr11_7_model_class ?? "llm_agent") as Sr117Class, intended_uses: strings(i.intended_uses), ...(Array.isArray(i.training_data_categories) ? { training_data_categories: strings(i.training_data_categories) } : {}), known_limitations: strings(i.known_limitations), instructions_for_use_and_human_review: strings(i.instructions_for_use_and_human_review) });
      if (!card.complete) throw new RangeError(`DOC_AI_SYSTEM_CARD incomplete: ${card.missing.join(", ")} (6-1-1702)`);
      const cardId = `${sysId}:${String(sys.version)}`; const delivered = str(i, "delivered_at") || null; const acknowledged = str(i, "acknowledged_at") || null;
      const createdOn = today(ctx);
      const data = rt.store.put("system_cards", cardId, { card_id: cardId, ai_system_id: sysId, version: sys.version, document_code: card.document_code, intended_uses: strings(i.intended_uses), training_data_categories: card.training_data_categories, known_limitations: strings(i.known_limitations), instructions_for_use_and_human_review: strings(i.instructions_for_use_and_human_review), created_on: createdOn, retain_until: developerRecordRetainUntil(createdOn), retention: "co_admt_3y", delivered_at: delivered, acknowledged_at: acknowledged, deployer: "partner" }, ctx.actor, ctx.now).data;
      if (delivered) {
        rt.store.put("ai_systems", sysId, { co_technical_documentation_document_id: card.document_code, co_docs_delivered_to_deployer_at: delivered, co_docs_acknowledged_at: acknowledged }, ctx.actor, ctx.now);
        sysEvent(ctx, "co_admt.developer_docs.delivered", sysId, { ai_system_id: sysId, version: sys.version, delivered_at: delivered, acknowledged: !!acknowledged, acknowledged_at: acknowledged, document_id: card.document_code });
      }
      return { ...data, complete: card.complete, state: systemState(rt.store.get("ai_systems", sysId)!.data) };
};


// ---------------------------------------------------------------- compliance-sentinel tools (gates, timers, escalations)

const gateEvaluate: Handler = (i, ctx, rt) => {
      const op = str(i, "op") || "deploy";
      switch (op) {
        case "deploy": {
          need(i, "ai_system_id"); const sysId = str(i, "ai_system_id"); const sys = row(rt, "ai_systems", sysId);
          const on = i.deploy_on ? D(str(i, "deploy_on")) : today(ctx);
          const facts = { assessment_kind: sys.assessment_kind ?? null, assessment_approved: sys.assessment_approved === true, eval_pass: sys.eval_pass === true, bias_tests_pass: sys.bias_tests_pass ?? null, risk_tier: String(sys.risk_tier ?? ""), partner_notified_at: sys.partner_notified_at ?? null, co_covered: sys.co_covered === true, co_docs_delivered_to_deployer_at: sys.co_docs_delivered_to_deployer_at ?? null, ...(sys.risk_tier === "high_consequential" ? { partner_officer_approved: sys.partner_officer_approved === true } : {}) };
          const g = evaluateGate("31.2.originationDeployGate", facts);
          const verdict = originationDeployGate({ ...facts, assessment_kind: facts.assessment_kind as "pre_deployment" | "material_modification" | "annual" | null, bias_tests_pass: facts.bias_tests_pass as boolean | null, partner_notified_at: facts.partner_notified_at as string | null, co_docs_delivered_to_deployer_at: facts.co_docs_delivered_to_deployer_at as string | null });
          if (!g.open) { sysEvent(ctx, "ai_system.deploy.blocked", sysId, { ai_system_id: sysId, version: sys.version, requested_on: on, gate: "SM_O122_ORIGINATION_AI_DEPLOY_GATE", reasons: verdict.reasons, reason: g.reason ?? null }); return { open: false, gate: "SM_O122_ORIGINATION_AI_DEPLOY_GATE", reasons: verdict.reasons, state: systemState(sys), deployed: false }; }
          const data = rt.store.put("ai_systems", sysId, { deployed_at: on, status: "deployed", deployed_by: ctx.actor.id }, ctx.actor, ctx.now).data;
          sysEvent(ctx, "ai_system.deploy.approved", sysId, { ai_system_id: sysId, version: sys.version, deployed_on: on, approved_by: ctx.actor.id, gate: "SM_O122_ORIGINATION_AI_DEPLOY_GATE" });
          return { open: true, gate: "SM_O122_ORIGINATION_AI_DEPLOY_GATE", reasons: [], state: systemState(data), deployed: true, deployed_on: on };
        }
        case "co_docs": {
          const application_id = appId(i, ctx); need(i, "ai_system_id", "consumer_state"); const sysId = str(i, "ai_system_id"); const sys = row(rt, "ai_systems", sysId);
          const on = i.on ? D(str(i, "on")) : today(ctx);
          const g = coDeveloperDocsGate({ consumer_state: str(i, "consumer_state"), on, materially_influences_consequential_decision: sys.materially_influences_consequential_decision === true, co_admt_role: String(sys.co_admt_role ?? "n_a"), co_docs_delivered_to_deployer_at: (sys.co_docs_delivered_to_deployer_at as string | null) ?? null, co_docs_acknowledged_at: (sys.co_docs_acknowledged_at as string | null) ?? null });
          ctx.events.append({ type: "ai_governance.path.routed", loanId: ctx.loanId, applicationId: application_id, aggregate: { kind: "applications", id: application_id }, actor: ctx.actor, payload: { application_id, ai_system_id: sysId, gate: g.gate, applies: g.applies, path: g.route, reasons: g.reasons, on, origination: true } });
          const esc = g.route === "human_path" ? rt.escalations.open({ kind: "sev1", applicationId: application_id, payload: { reason: "CO_SB26_189_1702_DEVELOPER_DOCS_GATE blocked", ai_system_id: sysId, reasons: g.reasons, route: "underwriting_reviewer decides without the ADMT's material influence" } }, ctx.actor) : null;
          return { ...g, blocked: !g.open, application_id, artifacts: g.route === "admt" && g.applies ? ["NTC_CO_SB26_189_ADMT_NOTICE{pre_use}", "CO_SB26_189_1704_ADVERSE_EXPLANATION_30", "CO_SB26_189_1705_HUMAN_REVIEW_30"] : [], escalation_id: esc?.id ?? null };
        }
        case "ca_readiness": {
          const application_id = appId(i, ctx); const on = i.on ? D(str(i, "on")) : today(ctx);
          const jr = rt.store.get("jurisdiction_rules", "CA")?.data; const ca = ((jr?.ai_governance as Record<string, unknown> | undefined)?.ca_admt as Record<string, unknown> | undefined) ?? {};
          const ready = rt.store.get("ca_admt_readiness", "CA")?.data ?? {};
          const g = caAdmtReadinessGate({ applicability_position: String(ca.applicability_position ?? str(i, "applicability_position") ?? "unresolved"), on, consumer_state: str(i, "consumer_state") || "CA", preuse_notice_live: ready.preuse_notice_live === true, optout_route_live: ready.optout_route_live === true, access_procedure_live: ready.access_procedure_live === true });
          ctx.events.append({ type: "ai_governance.path.routed", loanId: ctx.loanId, applicationId: application_id, aggregate: { kind: "applications", id: application_id }, actor: ctx.actor, payload: { application_id, gate: g.gate, applies: g.applies, path: g.route, reasons: g.reasons, on, origination: true } });
          const esc = g.route === "human_path" ? rt.escalations.open({ kind: "sev1", applicationId: application_id, payload: { reason: "CA_CPPA_7200_ADMT_READINESS_20270101 not satisfied", reasons: g.reasons } }, ctx.actor) : null;
          return { ...g, blocked: !g.open, application_id, escalation_id: esc?.id ?? null };
        }
        default: throw new RangeError(`gate.evaluate op ${op} is not one of deploy/co_docs/ca_readiness`);
      }
};

const escalationsOpen: Handler = (i, ctx, rt) => { need(i, "reason"); return escalate("officer")(i, ctx, rt); };
const timersRead: Handler = (i, ctx) => timerOps()({ ...i, op: i.op === "open" ? "open" : "list", subject_kind: str(i, "subject_kind") || "ai_systems", subject_id: str(i, "subject_id") || str(i, "ai_system_id") || "*" }, ctx);


// ---------------------------------------------------------------- the two spec-named tools (agents.json: `inventory.upsert`, `assess.draft`) dispatch the whole paragraph on `op`
const INVENTORY_OPS = ["version", "partner_notified", "jurisdiction", "ca_readiness", "ca_attestation", "restrict", "unrestrict", "retire", "rights_request", "rights_complete"] as const;
const INVENTORY_EXTRA_OPS = ["eval", "bias", "leakage", "card", "material_update", "acknowledge", "deploy", "co_docs", "ca_readiness_gate", "drift_dispose", "drift_sweep", "timers", "escalate"] as const;
const ASSESS_OPS = ["draft", "approve", "monitor", "close_review", "complaint_intake", "complaint_triage", "reviewer_metrics", "decision_record", "test", "reasons", "lda", "pack", "fnma_disclosure"] as const;
export const TOOLS_31_2: readonly ToolDef[] = defineTools("31.2", QC, [
  /**
   * `inventory.upsert` — the inventory and deploy pipeline: op version (default) | partner_notified | jurisdiction | ca_readiness |
   * ca_attestation | restrict | unrestrict | retire | rights_request | rights_complete (the ai_systems / jurisdiction_rules /
   * consumer_ai_rights_requests rows), eval (`eval.run(suite, version)`), bias / leakage (`bias.runSuite`), card |
   * material_update | acknowledge (`cards.render`), deploy | co_docs | ca_readiness_gate (`gate.evaluate` — deploy is the
   * officer's), drift_dispose | drift_sweep (`drift.watch`), timers (`timers.read`), escalate (`escalations.open`).
   */
  { name: "inventory.upsert", kind: "act", handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "version";
      if ((INVENTORY_OPS as readonly string[]).includes(op)) return versionOps(i, ctx, rt);
      switch (op) {
        case "eval": return evalRun(i, ctx, rt);
        case "bias": return biasSuite({ ...i, op: "suite" }, ctx, rt);
        case "leakage": return biasSuite(i, ctx, rt);
        case "card": case "material_update": case "acknowledge": return cardsRender(i, ctx, rt);
        case "deploy": case "co_docs": return gateEvaluate(i, ctx, rt);
        case "ca_readiness_gate": return gateEvaluate({ ...i, op: "ca_readiness" }, ctx, rt);
        case "drift_dispose": return driftWatch({ ...i, op: "dispose" }, ctx, rt);
        case "drift_sweep": return driftWatch({ ...i, op: "sweep" }, ctx, rt);
        case "timers": return timersRead(i, ctx, rt);
        case "escalate": return escalationsOpen(i, ctx, rt);
        default: throw new RangeError(`inventory.upsert op ${op} is not one of ${[...INVENTORY_OPS, ...INVENTORY_EXTRA_OPS].join("/")}`);
      }
    }),
    guardrails: [needsRole("DEPLOY_APPROVAL_IS_THE_OFFICERS", GUARD + "; escalations: deployment approval (SM `officer`; partner `officer` for high-risk systems)", (i) => str(i, "op") === "deploy", ["officer"], "the agents never approve a deployment — the SM officer requests it through the gate"),
      never("NO_AGENT_DEPLOYMENT", GUARD, (i) => str(i, "op") !== "deploy" && (flag(i, "deploy") || flag(i, "deployed")), "the agents never approve a deployment — deployment is the officer's inventory.upsert{op=deploy} through SM_O122_ORIGINATION_AI_DEPLOY_GATE"),
      never("CARD_NEVER_CITES_PROHIBITED_BASIS", GUARD + " (rationale guard)", (i) => strings(i.instructions_for_use_and_human_review).concat(strings(i.known_limitations)).some((t) => !rationaleGuard(t).ok), "developer documentation never describes a prohibited basis or proxy as an input"),
      NO_BORROWER_CONTACT] },
  /**
   * `assess.draft` — assessment, monitoring and evidence: op draft (default) | approve (officer) — the assessment; monitor
   * (`monitor.run(scope, period)`), close_review (officer) | complaint_intake | complaint_triage | reviewer_metrics |
   * decision_record; test (`monitor.test(metric, dimension)`); reasons (`reasons.replay(sample)`); lda (`lda.search(subject)`);
   * pack | fnma_disclosure (`pack.compile`).
   */
  { name: "assess.draft", kind: "act", handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "draft";
      switch (op) {
        case "draft": case "approve": return assessOps(i, ctx, rt);
        case "monitor": return monitorRun({ ...i, op: "run" }, ctx, rt);
        case "close_review": case "complaint_intake": case "complaint_triage": case "reviewer_metrics": case "decision_record": return monitorRun(i, ctx, rt);
        case "test": return monitorTest(i, ctx, rt);
        case "reasons": return reasonsReplay(i, ctx, rt);
        case "lda": return ldaSearch(i, ctx, rt);
        case "pack": return packCompile({ ...i, op: "quarterly" }, ctx, rt);
        case "fnma_disclosure": return packCompile(i, ctx, rt);
        default: throw new RangeError(`assess.draft op ${op} is not one of ${ASSESS_OPS.join("/")}`);
      }
    }),
    guardrails: [needsRole("ASSESSMENT_APPROVAL_IS_THE_OFFICERS", GUARD + "; escalations: deployment approval (SM `officer`; partner `officer` for high-risk systems)", (i) => str(i, "op") === "approve", ["officer"], "an assessment is approved by the SM officer (partner officer for high-risk systems)"),
      needsRole("FINDING_CLOSURE_IS_THE_OFFICERS", GUARD, (i) => str(i, "op") === "close_review", ["officer"], "a finding is never marked closed without an officer disposition"),
      needsRole("FNMA_DISCLOSURE_SENT_BY_OFFICER", "19.3: Fannie Mae notices are officer-sent (`fnma_notices.recordSent`); 31.2 escalations: Fannie Mae disclosure (`officer` via 19.3)", (i) => flag(i, "send"), ["officer"], "the LL-2026-04 disclosure response is signed and sent by the officer through 19.3"),
      NO_ROW_LEVEL_DEMOGRAPHICS, NO_BORROWER_CONTACT, NO_RULE_CHANGE,
      never("RATIONALE_GUARD", GUARD + " (rationale guard; rule 3 rationale_guard)", (i) => str(i, "op") === "decision_record" && !!str(i, "rationale") && !rationaleGuard(str(i, "rationale")).ok, "the rationale references a prohibited basis or proxy — rule identifiers and legitimate factors only")] },
]);
