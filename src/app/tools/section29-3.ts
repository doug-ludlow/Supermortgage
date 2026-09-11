/**
 * §29.3 process-owned tools — bus tools for 29.3 defined with `defineTools("29.3", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 29.3; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The `secondary` agent runs in loan + application scope after funding. State lives in one `DeliveryBuildService`
 * per runtime (`rt.services["delivery-29-3"]` when the caller wires it, else created over the command context's event
 * store and the runtime's escalation service, with the EarlyCheck DI port from `rt.services["earlycheck"]` or the
 * fake). Every act goes through the pure rules in src/domain/secondary/ops-29-3.ts, which append the events the 29.3
 * timers and 29.4 consume. Guardrails encode the spec's sentences: the agent never types a value that is not traceable
 * to a source record (every override requires a rule reference and is limited to enumeration defaults and formatting —
 * never amounts, dates, scores, values, identifiers); never bypasses a fatal or warning-to-fatal edit; never drops an SFC
 * to fit the cap; never rebuilds after submission; never submits to Loan Delivery (29.4); never alters the DU casefile,
 * UCD, UCDP or MI records — it asks their owners. Escalations: `fnma_portal_operator` (EarlyCheck UI fallback; LDTE),
 * `officer` (partner) for an SFC set > 10 and any TPO-code question (211/212), `qc_officer` for the edit-frequency report.
 */
import { defineTools, compute, decision, never, needsRole, str, flag, cents, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { DeliveryBuildService, FakeEarlyCheck, collectPrerequisites, reconcileIdentifiers, assembleUlddDataPoints, assignSfcs, sfc067Gate, valueAcceptanceGate, sfcCompletenessGate, validateSchema, buildUlddXml, mapEditToOwner, derivedFixAllowed, NON_DERIVABLE_SORT_IDS, SFC_CAP, RULE_SET_VERSIONS_29_3, type LoanFileBase, type LoanFile, type EarlyCheckPort, type EarlyCheckEdit, type EarlyCheckResult, type EditResolution, type SfcFlags } from "../../domain/secondary/ops-29-3.ts";

type Rt = ToolRuntime; type Ctx = CommandContext; type Row = Record<string, unknown>;
const need = (i: ToolInput, ...keys: string[]): void => { const gaps = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (gaps.length) throw new RangeError(`29.3 tool needs ${gaps.join(", ")}`); };
const obj = <T>(i: ToolInput, key: string): T => { const f = i[key]; if (!f || typeof f !== "object") throw new RangeError(`29.3 tool needs ${key}`); return f as T; };
const services = new WeakMap<Rt, DeliveryBuildService>();
const svc = (rt: Rt, ctx: Ctx): DeliveryBuildService => {
  const wired = rt.services["delivery-29-3"] as DeliveryBuildService | undefined; if (wired) return wired;
  let s = services.get(rt);
  if (!s) { s = new DeliveryBuildService({ events: ctx.events, clock: ctx.clock, escalations: rt.escalations, earlycheck: (rt.services["earlycheck"] as EarlyCheckPort | undefined) ?? new FakeEarlyCheck(), flags: (rt.services["flags-29-3"] as SfcFlags | undefined) ?? {}, ...(ctx.run ? { agent_run_id: ctx.run.runId } : {}) }); services.set(rt, s); }
  return s;
};
const deliveryOf = (i: ToolInput, ctx: Ctx, rt: Rt) => { const s = svc(rt, ctx); const id = str(i, "delivery_id"); if (id) return s.get(id); const app = str(i, "application_id") || ctx.applicationId || ""; const r = app ? s.byApplication(app) : null; if (!r) throw new RangeError("29.3 tool needs delivery_id (or an application with an open delivery — collectPrerequisites first)"); return r; };
const c = (v: unknown): bigint => cents(v);
/** The loan-file base as the caller (30.2 boarding / the ops console) hands it: cents as strings, dates as PlainDate strings. */
function toBase(raw: Row): LoanFileBase {
  const r = raw as Record<string, unknown>;
  for (const k of ["application_id", "loan_id", "partner_id", "seller_number", "servicing_loan_number", "purpose", "loan_amount_cents", "note_rate_pct", "term_months", "note_date", "disbursement_date", "first_payment_date", "maturity_date", "appraised_value_cents", "property", "lock", "warehouse", "note", "notarization_kind", "credit", "hmda", "valuation"]) if (r[k] === undefined || r[k] === null || r[k] === "") throw new RangeError(`29.3 loan file base needs ${k}`);
  const mi = r.mi as Row | null | undefined; const subs = Array.isArray(r.subordinations) ? (r.subordinations as Row[]) : [];
  return { ...(r as unknown as LoanFileBase), loan_amount_cents: c(r.loan_amount_cents), appraised_value_cents: c(r.appraised_value_cents), sales_price_cents: r.sales_price_cents === undefined || r.sales_price_cents === null ? null : c(r.sales_price_cents), initial_escrow_deposit_cents: r.initial_escrow_deposit_cents === undefined || r.initial_escrow_deposit_cents === null ? null : c(r.initial_escrow_deposit_cents),
    note_date: D(String(r.note_date)), disbursement_date: D(String(r.disbursement_date)), first_payment_date: D(String(r.first_payment_date)), maturity_date: D(String(r.maturity_date)), escrowed: r.escrowed === true, term_months: Number(r.term_months),
    subordinations: subs.map((s) => ({ amount_cents: c(s.amount_cents), community_seconds: s.community_seconds === true })), ...(mi ? { mi: { ...(mi as unknown as NonNullable<LoanFile["mi"]>), financed_premium_cents: c(mi.financed_premium_cents) } } : {}) };
}
const editOf = (i: ToolInput): EarlyCheckEdit => { const e = obj<Row>(i, "edit"); if (typeof e.edit_code !== "string" || typeof e.severity !== "string") throw new RangeError("29.3 tool needs edit{edit_code, severity, sort_ids[]}"); return { edit_code: e.edit_code, severity: e.severity as EarlyCheckEdit["severity"], message: String(e.message ?? ""), sort_ids: Array.isArray(e.sort_ids) ? (e.sort_ids as string[]).map(String) : [], ...(typeof e.kind === "string" ? { kind: e.kind as NonNullable<EarlyCheckEdit["kind"]> } : {}), ...(typeof e.prefix === "string" ? { prefix: e.prefix as NonNullable<EarlyCheckEdit["prefix"]> } : {}) }; };
const typesValue = (i: ToolInput): boolean => i.override_value !== undefined && i.override_value !== null && !str(i, "rule_ref");
const touchesNonDerivable = (i: ToolInput): boolean => Array.isArray(i.sort_ids) && (i.sort_ids as unknown[]).some((s) => (NON_DERIVABLE_SORT_IDS as readonly string[]).includes(String(s)));

export const TOOLS_29_3: readonly ToolDef[] = defineTools("29.3", "secondary", [
  // `loan.funded`: every prerequisite record from the finished processes' events (SFCs, identifiers, MI, eNote, commitment, warehouse context) — the delivery row opens `pending_prerequisites`.
  { name: "collectPrerequisites", kind: "act", ruleSetVersion: RULE_SET_VERSIONS_29_3.uldd, handler: compute((i, ctx, rt) => { need(i, "base"); const base = toBase(obj<Row>(i, "base")); const file = collectPrerequisites(ctx.events, base); const row = svc(rt, ctx).open(file, str(i, "delivery_id") || `DLV-${file.loan_id}`);
      return { delivery_id: row.delivery_id, build_status: row.build_status, prerequisite_checks: file.prerequisite_checks, missing: file.prerequisite_checks.filter((x) => !x.present).map((x) => x.name), sfc_queue: file.sfc_queue, package_incomplete_reason: file.package_incomplete_reason }; }),
    guardrails: [never("NEVER_ALTERS_UPSTREAM_RECORDS", "29.3 guardrails: never alters the DU casefile, UCD, UCDP or MI records — it asks their owners", (i) => flag(i, "write_du_casefile") || flag(i, "write_ucd") || flag(i, "write_ucdp") || flag(i, "write_mi_certificate"), "a missing or wrong identifier is a correction request to its owner (23.1/24.2/24.6/25.2), never a write from 29.3")] },
  // R2: every Appendix D row this build populates, with provenance per Sort ID (a pure projection of the delivery's loan file and identifier snapshot).
  { name: "assembleUlddDataPoints", kind: "read", handler: compute((i, ctx, rt) => { const r = deliveryOf(i, ctx, rt); const ids = reconcileIdentifiers(r.file, D(ctx.now.slice(0, 10))); const sfc = assignSfcs(r.file); const a = assembleUlddDataPoints(r.file, ids.snapshot, sfc.included, D(ctx.now.slice(0, 10)));
      return { delivery_id: r.delivery_id, build_no: r.uldd_build_no, points: a.points, populated: a.points.filter((p) => p.value !== null).length, identifier_mismatches: ids.mismatches }; }) },
  // R2 conditionality: the CR/CI business conditions evaluated from the loan (`condition_evaluated = true`, result recorded) so gate T5 can prove the decision.
  { name: "evaluateConditionality", kind: "read", handler: compute((i, ctx, rt) => { const r = deliveryOf(i, ctx, rt); const ids = reconcileIdentifiers(r.file, D(ctx.now.slice(0, 10))); const sfc = assignSfcs(r.file); const a = assembleUlddDataPoints(r.file, ids.snapshot, sfc.included, D(ctx.now.slice(0, 10)));
      return { delivery_id: r.delivery_id, conditionality_decisions: a.conditionality_decisions, unpopulated_conditional: a.points.filter((p) => p.conditionality !== "R" && p.value === null).map((p) => ({ sort_id: p.sort_id, name: p.data_point_name, condition: p.condition })) }; }) },
  // R4: the SFC set from the queued codes plus indicator-derived codes; > 10 is the officer's call — nothing is dropped to fit the cap.
  { name: "assignSfcs", kind: "act", ruleSetVersion: RULE_SET_VERSIONS_29_3.sfc, handler: compute((i, ctx, rt) => { const r = deliveryOf(i, ctx, rt); const sfc = assignSfcs(r.file, (rt.services["flags-29-3"] as SfcFlags | undefined) ?? {}); const g067 = sfc067Gate(r.file, sfc.included); const gva = valueAcceptanceGate(r.file, sfc.included); const gate = sfcCompletenessGate({ sfc_count: sfc.count, contradictions: sfc.contradictions, required_missing: [] });
      let escalation_id: string | null = null;
      if (sfc.over_cap) escalation_id = rt.escalations.open({ kind: "officer", ownerRole: "officer", applicationId: r.application_id, loanId: r.loan_id, payload: { reason: "sfc_over_cap", candidates: sfc.assignments.map((a) => ({ code: a.sfc_code, rule_ref: a.rule_ref })), count: sfc.count, cap: SFC_CAP } }, ctx.actor).id;
      return { delivery_id: r.delivery_id, assignments: sfc.assignments, included: sfc.included, count: sfc.count, over_cap: sfc.over_cap, contradictions: sfc.contradictions, gates: { FNMA_C1_2_02_SFC_COMPLETENESS_GATE: gate, FNMA_LL_2026_06_SFC_067_CONSISTENCY_GATE: g067, FNMA_B4_1_4_10_VALUE_ACCEPTANCE_SFC_GATE: gva }, escalation_id }; }),
    guardrails: [never("SFC_NEVER_DROPPED", "29.3 guardrails: never drops an SFC to fit the cap; R4: escalate to `officer` rather than silently dropping a code", (i) => flag(i, "fit_to_cap") || (Array.isArray(i.drop_codes) && (i.drop_codes as unknown[]).length > 0), "over ten SFCs is an officer escalation with the candidate list and rule references; codes are removed only when the Business Rules Dictionary lists them as derived by Loan Delivery"),
      never("SFC_ONLY_FROM_OWNER_EVENTS", "29.3 R4 / seam contract: special feature codes come from the finished processes' events, never recomputed", (i) => Array.isArray(i.add_codes) && (i.add_codes as unknown[]).length > 0 && !str(i, "source_event_id"), "an SFC is added only with the owning process's event as its evidence")] },
  // R3: identifier equalities/format checks a–q over the loan file; mismatches name the owner (23.1/24.2/24.3/24.6/25.2/26.x/29.x).
  { name: "reconcileIdentifiers", kind: "read", handler: compute((i, ctx, rt) => { const r = deliveryOf(i, ctx, rt); const ids = reconcileIdentifiers(r.file, D(ctx.now.slice(0, 10))); return { delivery_id: r.delivery_id, identifier_snapshot: ids.snapshot, mismatches: ids.mismatches, complete: ids.complete, gate: ids.complete ? "open" : "closed" }; }) },
  // `buildUldd`: the guarded assembly — prerequisites → R3 → R4 → LL-2026-06 → B4-1.4-10 → DU-file EarlyCheck gate → schema-valid XML, hashed (`delivery.uldd.built`). `op=supersede` reopens a frozen package on a mapped-source change.
  { name: "buildUlddXml", kind: "act", ruleSetVersion: RULE_SET_VERSIONS_29_3.uldd, handler: compute((i, ctx, rt) => { const s = svc(rt, ctx); const r = deliveryOf(i, ctx, rt);
      if (i.op === "supersede") { need(i, "reason"); const out = s.supersede(r.delivery_id, str(i, "reason"), { awaiting_cd_version: i.awaiting_cd_version === undefined ? null : Number(i.awaiting_cd_version) }); return { delivery_id: r.delivery_id, superseded_package_id: out.package?.package_id ?? null, cancelled_task_ids: out.cancelled_task_ids }; }
      if (i.op === "rebuild") { need(i, "base", "reason"); const out = s.rebuild(r.delivery_id, toBase(obj<Row>(i, "base")), str(i, "reason")); return { delivery_id: r.delivery_id, status: out.status, gate: out.gate, reason: out.reason, build_no: out.build?.build_no ?? null, sha256: out.build?.sha256 ?? null }; }
      if (i.op === "serialize") { const ids = reconcileIdentifiers(r.file, D(ctx.now.slice(0, 10))); const sfc = assignSfcs(r.file); const a = assembleUlddDataPoints(r.file, ids.snapshot, sfc.included, D(ctx.now.slice(0, 10))); return buildUlddXml(a.points, sfc.included, { seller_number: r.file.seller_number, build_no: r.uldd_build_no + 1, build_on: D(ctx.now.slice(0, 10)) }); }
      const du = i.du_file_run as { run_id: string; file_sha256: string; clean: boolean; result_document_id: string } | undefined;
      const out = s.assemble(r.delivery_id, { du_file_run: du ?? null });
      return { delivery_id: r.delivery_id, status: out.status, gate: out.gate, reason: out.reason, mismatches: out.mismatches, build_no: out.build?.build_no ?? null, sha256: out.build?.sha256 ?? null, document_id: out.build?.document_id ?? null, sfcs: out.build?.sfcs ?? null, escalation_id: out.escalation_id }; }),
    guardrails: [never("REBUILD_AFTER_SUBMISSION", "29.3 guardrails: never rebuilds after submission; state machine: `assembling` refused while loan_delivery_status ∈ {purchase_requested, purchase_ready, purchased_and_funded}", (i) => flag(i, "after_submission") || flag(i, "force_rebuild_after_submission"), "post-submission corrections go through 29.4's data-revision or PPA paths, never a silent rebuild"),
      never("NO_TYPED_VALUES", "29.3 guardrails: never types a value that is not traceable to a source record", (i) => typesValue(i) || (i.override_value !== undefined && touchesNonDerivable(i)), "an override needs a rule reference and is limited to enumeration defaults and formatting — never amounts, dates, scores, values, identifiers")] },
  // R2 schema/enumeration/format checks over a build (Appendix E enumerations; FAQ Q25/Q36 reasonable-value rules) — unknown enumerations fail, never coerced.
  { name: "validateSchema", kind: "read", handler: compute((i, ctx, rt) => { if (Array.isArray(i.points)) return validateSchema(i.points as Parameters<typeof validateSchema>[0], Array.isArray(i.sfcs) ? (i.sfcs as string[]) : []); const r = deliveryOf(i, ctx, rt); const s = svc(rt, ctx); const pts = s.points.filter((p) => p.delivery_id === r.delivery_id && p.build_no === r.uldd_build_no); return { delivery_id: r.delivery_id, build_no: r.uldd_build_no, ...validateSchema(pts, r.sfc_codes) }; }) },
  // EarlyCheck over DI on the current build (idempotent per (delivery, hash, kind)); `op=sweep` opens the UI fallback after 60 minutes; `op=attach_ui_result` records the operator's export against the hash actually run.
  { name: "runEarlyCheck", kind: "act", handler: compute((i, ctx, rt) => { const s = svc(rt, ctx);
      if (i.op === "sweep") return { fallbacks: s.sweep(ctx.now) };
      if (i.op === "attach_ui_result") { need(i, "run_id", "file_sha256_run", "result"); const run = s.attachUiResult(str(i, "run_id"), { file_sha256_run: str(i, "file_sha256_run"), result: obj<EarlyCheckResult>(i, "result"), operator: ctx.actor }); return { run_id: run.run_id, channel: run.channel, clean: run.clean, file_sha256: run.file_sha256, edit_count_by_severity: run.edit_count_by_severity }; }
      const r = deliveryOf(i, ctx, rt); const run = s.runEarlyCheck(r.delivery_id);
      return { delivery_id: r.delivery_id, run_id: run.run_id, file_kind: run.file_kind, file_sha256: run.file_sha256, channel: run.channel, completed: run.completed_at !== null, clean: run.clean, edit_count_by_severity: run.edit_count_by_severity, edits: s.edits.filter((e) => e.run_id === run.run_id).map((e) => ({ edit_id: e.edit_id, edit_code: e.edit_code, severity: e.severity, owner_process: e.owner_process, sort_ids: e.sort_ids })) }; }),
    guardrails: [needsRole("UI_RESULT_BY_OPERATOR", "29.3 integrations: outage → `fnma_portal_operator` runs the same file through the EarlyCheck web UI and attaches the UI export (`channel = ui`)", (i) => i.op === "attach_ui_result", ["fnma_portal_operator"], "the UI export is attached by the portal operator who ran it"),
      never("SAME_FILE_SAME_HASH", "29.3 hash rule: the gate evaluates the hash of the file actually run; a different file is never certified as clean", (i) => i.op === "attach_ui_result" && flag(i, "certify_different_file"), "the UI run must be of the identical file (hash shown on the task)")] },
  // Loan Delivery FAQ Q9 routing: A → 24.2, C → 25.2, D/DU Compare → 23.1 (source_corrected_upstream), 3000-series → 29.1; derivable kinds stay here.
  { name: "mapEditToOwner", kind: "read", handler: compute((i) => { const e = editOf(i); return { ...mapEditToOwner(e), derived_fix: derivedFixAllowed(e) }; }) },
  // Worked example B / T11: a derived fix (enumeration default such as SID 429, EarlyCheck's standardized address, a format trim) rebuilds; `op=resolve` records a resolution — a fatal / warning-to-fatal / DU Compare bypass is refused.
  { name: "applyDerivedFix", kind: "act", handler: compute((i, ctx, rt) => { const s = svc(rt, ctx); need(i, "edit_id");
      if (i.op === "resolve") { need(i, "resolution", "resolution_ref"); const e = s.resolveEdit(str(i, "edit_id"), str(i, "resolution") as EditResolution, { resolution_ref: str(i, "resolution_ref"), by: `${ctx.actor.kind}:${ctx.actor.id}` }); return { edit_id: e.edit_id, resolution: e.resolution, resolution_ref: e.resolution_ref, owner_process: e.owner_process }; }
      need(i, "base"); const out = s.applyDerivedFix(str(i, "edit_id"), toBase(obj<Row>(i, "base")));
      return { edit_id: out.edit.edit_id, resolution: out.edit.resolution, build_no: out.build?.build_no ?? null, sha256: out.build?.sha256 ?? null, property_audit: out.property_audit }; }),
    guardrails: [never("NEVER_BYPASS_FATAL", "29.3 guardrails: never bypasses a fatal or warning-to-fatal edit; C1-2-02 'clear of all fatal edits'", (i) => i.op === "resolve" && str(i, "resolution") === "bypassed_with_justification" && (str(i, "severity") === "fatal" || str(i, "severity") === "warning_to_fatal"), "a fatal or warning-to-fatal edit is corrected at its source, never bypassed"),
      never("DU_COMPARE_UPSTREAM_ONLY", "29.3 R5 / T11: a DU Compare difference is resolved `source_corrected_upstream` via 23.1 — a bypass is refused", (i) => i.op === "resolve" && str(i, "resolution") === "bypassed_with_justification" && (str(i, "kind") === "du_compare" || str(i, "prefix") === "D"), "DU Compare edits are corrected by 23.1, never bypassed here"),
      never("NO_TYPED_VALUES", "29.3 guardrails: every `override_value` requires a rule reference and is limited to enumeration defaults and formatting", (i) => typesValue(i) || (i.override_value !== undefined && touchesNonDerivable(i)), "amounts, dates, scores, values and identifiers are never typed by the agent")] },
  // `freezePackage`: clean run over exactly this build's bytes, every composed gate open, the package hashed and handed to 29.4 (`delivery.package.frozen`); the agent never submits to Loan Delivery.
  { name: "freezePackage", kind: "act", ruleSetVersion: RULE_SET_VERSIONS_29_3.selling, handler: compute((i, ctx, rt) => { const s = svc(rt, ctx); const r = deliveryOf(i, ctx, rt);
      if (i.op === "gate_results") return { delivery_id: r.delivery_id, gate_results: s.gateResults(r) };
      const pkg = s.freeze(r.delivery_id);
      return { delivery_id: r.delivery_id, package_id: pkg.package_id, version: pkg.version, uldd_sha256: pkg.uldd_sha256, earlycheck_run_id: pkg.earlycheck_run_id, sfc_codes: pkg.sfc_codes, gate_results: pkg.gate_results, frozen_at: pkg.frozen_at, status: pkg.status, decision: s.decisionRecord(r.delivery_id) }; }),
    guardrails: [never("NEVER_SUBMITS_TO_LOAN_DELIVERY", "29.3 guardrails: never submits to Loan Delivery (29.4); Loan Delivery has no API — a human operator imports the frozen package", (i) => flag(i, "submit_to_loan_delivery") || flag(i, "import_to_loan_delivery"), "the frozen, hashed package is handed to 29.4's fnma_portal_operator task"),
      never("NEVER_BYPASS_FATAL", "29.3 guardrails: never bypasses a fatal or warning-to-fatal edit", (i) => flag(i, "ignore_fatal_edits") || flag(i, "freeze_with_fatal"), "freeze is refused until the EarlyCheck run over these exact bytes is clean")] },
  // LL-2026-04: every build is an `agent_decisions` row with rule-set, model and prompt versions and the edits resolved by rule.
  { name: "writeDecision", kind: "act", handler: decision() },
]);
