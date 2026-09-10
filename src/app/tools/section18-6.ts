/**
 * §18.6 tools — the attestation module of `qc-audit`: `control_evidence.generate(period)`, QC results queries, timer
 * histories, document export, letter renderer, `escalations.create` (spec "Tools:" line), plus the state-changing acts the
 * §18.6 timer table is satisfied by (`attestation_package.transition`, `material_noncompliance.determine`, `partner.notify`,
 * `attestation_report.receive`), the onboarding / cycle events that arm them (`investor_program.create`,
 * `attestation.cycle.open`), the matrix and exception register (`control_matrix.upsert`, `control_exceptions.list`,
 * `control_exception.record`, `exception.disposition`) and the FYE + 30 warning (`attestation.warning.check`).
 *
 * Every gate of the state machine reads the stores, never a caller's flag: the stored `attestation_packages.status` is the only
 * `from`; the cycle reads the *recorded* `investor_programs` determination (ops-18-6 applicabilityConflicts — a caller's
 * `program_kind` / PSA days never override it); `evidence_compiled` needs the `control_evidence` binder complete for every
 * `control_matrix` row on file for the package period (ops-18-6 evidenceCompleteness — no matrix on file is never complete, and a
 * binder cites only `documents` on file, with their hashes: evidenceDocumentsOnFile); `exceptions_evaluated` needs the exception
 * register — every `qc_findings` row tagged to a 1122(d) criterion plus every recorded timer breach, one register for every package,
 * never scoped by a caller's `package_id` — dispositioned by the officer (exceptionRegister); `attestation_received` needs the
 * accountant's report on file with its hash (auditorReportCheck); the Item 1122 assertion is rendered from the package's stored
 * material-noncompliance determinations. The register (`regab_control_exceptions`, distinct from §17's `control_exceptions`) is
 * append-only: a recorded row is never re-recorded, and leaves the open list only on an officer disposition with rationale.
 * Guardrails encode the spec's sentences: the agent never signs or asserts (management assertions and 1123 statements are officer
 * acts — baseline §8 item 3); a material instance of noncompliance is the officer's determination on counsel's advice.
 *
 * `attestationReactors_18_6` are the module's event subscribers (the pattern of src/domain/transfers/inbound.ts): §6.3's
 * `reconciliation_item.opened` → the Reg AB view `regab.reconciling_item.opened{regab_applicable}` on a per-item aggregate that
 * arms REGAB_1122_2VII_RECON_ITEMS_90 (ops-18-6 classifyReconItem); §6.3's `reconciliation_item.resolved` → the same view
 * `regab.reconciling_item.resolved{status}` on that item's aggregate, the clock's satisfier (reconItemResolvedView — keyed per
 * item so one item's resolution never satisfies another's clock); and that clock's `timer.breached` → the control exception for
 * 1122(d)(2)(vii) recorded on the register (18.6-T4). They need wiring wherever the app builds its unit of work.
 *
 * `TOOLS_18_6` — the slice spread onto the bus by ./section18.ts — is the subset whose names spec/registry/agents.json lists
 * for 18.6 (src/app/tools.test.ts refuses any other name on the bus); the extractor currently reads no tool names from the
 * 18.6 "Tools:" line, so the full surface is exported as `ATTESTATION_TOOLS_18_6` and bound by 18-6.spec.test.ts exactly as
 * ./index.ts would bind it once the registry names them.
 */
import { defineTools, escalate, compute, never, needsRole, humanWhen, str, flag, type ToolDef, type ToolInput, type ToolRuntime, type EntityStore } from "../tools.ts";
import { loadAgentsFile } from "../agents.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { SYSTEM, type EventStore, type DomainEvent } from "../../kernel/events/index.ts";
import type { TimerEngine } from "../../kernel/timers/index.ts";
import { removeException, exceptionList, type ControlException } from "../../domain/qc-audit/ops.ts";
import { PROGRAM_KINDS, PACKAGE_STATES, REPORT_KIND, regAbApplicability, attestationCycleEvent, controlEvidenceBinder, evidenceCompleteness, evidenceDocumentsOnFile, exceptionRegister, packageTransition, officerSignatureRecord, materialNoncomplianceDisclosure, assessmentReport, subCertification, controlExceptions, classifyReconItem, reconItemResolvedView, reconItemControlException, applicabilityConflicts, assessmentWarning, type ProgramKind, type PackageKind, type PackageStatus, type OfficerSignature, type ControlFrequency, type MaterialNoncomplianceItem, type AuditorReportRecord, type RecordedProgram } from "../../domain/qc-audit/ops-18-6.ts";

const AGENT = "qc-audit";
/** The Reg AB exception register collection / table (db 0051) — distinct from §17's `control_exceptions` (security-control waivers, 0022). */
export const EXCEPTIONS = "regab_control_exceptions";
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const list = <T,>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const optNum = (i: ToolInput, k: string): number | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : Number(i[k]));
const cycleAggregate = (i: ToolInput): { kind: "attestation_cycle"; id: string } => ({ kind: "attestation_cycle", id: str(i, "cycle_id") });
const signatureOf = (i: ToolInput): OfficerSignature | null => { const s = i.signature as Partial<OfficerSignature> | undefined; return s && typeof s === "object" ? { officer_id: String(s.officer_id ?? ""), signer_role: String(s.signer_role ?? ""), signed_at: String(s.signed_at ?? ""), document_id: String(s.document_id ?? "") } : null; };
const PARTNER_REASONS = ["material_noncompliance", "supplemental_disclosure", "attestation_delivery", "auditor_request"];

interface StoredPackage { id: string; cycle_id?: string; entity?: string; kind: PackageKind; status: PackageStatus; period_start?: PlainDate; period_end?: PlainDate; criteria_scope?: string[]; material_noncompliance?: MaterialNoncomplianceItem[]; auditor_report_document_id?: string | null; partner_entity?: string | null; program_id?: string; }
interface MatrixRow { control_code: string; criterion: string; frequency?: ControlFrequency; }
interface EvidenceRow { control_code: string; criterion: string; period_start: PlainDate; period_end: PlainDate; complete: boolean; generated_at: string; }

const requirePackage = (rt: ToolRuntime, id: string): StoredPackage => { const r = rt.store.get("attestation_packages", id); if (!r) throw new RangeError(`no attestation_packages ${id} — attestation.cycle.open creates the cycle's packages`); return r.data as unknown as StoredPackage; };
const matrixRows = (rt: ToolRuntime): MatrixRow[] => rt.store.list("control_matrix").map((r) => r.data as unknown as MatrixRow);
/** The package period as stored (a missing end/start falls back to the calendar year of the other). */
const packagePeriod = (pkg: StoredPackage): { period_start: PlainDate; period_end: PlainDate } => ({ period_start: pkg.period_start ?? D(`${String(pkg.period_end ?? "").slice(0, 4)}-01-01`), period_end: pkg.period_end ?? D(`${String(pkg.period_start ?? "").slice(0, 4)}-12-31`) });
/**
 * The evidence gate as the stores hold it: the `control_matrix` rows on file (in the package's scope) × the latest `control_evidence`
 * per control for exactly the package period. Only the stored matrix counts — a binder generated from a caller's inline matrix never
 * stands in for it (no matrix on file → `controls: 0` → not complete; SM_ATTEST_EVIDENCE_COMPILE_FYE_15 'complete for all matrix rows').
 */
function evidenceFromStore(rt: ToolRuntime, pkg: StoredPackage): ReturnType<typeof evidenceCompleteness> {
  const { period_start, period_end } = packagePeriod(pkg);
  const evidence = rt.store.list("control_evidence").map((r) => r.data as unknown as EvidenceRow);
  return evidenceCompleteness({ period_start, period_end, matrix: matrixRows(rt), criteria_scope: pkg.criteria_scope ?? [], evidence });
}
/**
 * The exception register as the stores hold it: every `qc_findings` row tagged to a 1122(d) criterion + every recorded
 * `regab_control_exceptions` row — one register for every package of every cycle. A `package_id` never scopes it: an exception is a
 * fact about a criterion, and a row tagged to (or dispositioned for) one package must neither vanish from another package's list nor
 * stay open for it once the officer has dispositioned it.
 */
function registerFromStore(rt: ToolRuntime): ReturnType<typeof exceptionRegister> {
  const findings = rt.store.list("qc_findings").map((r) => ({ id: String(r.data.id ?? r.id), severity: String(r.data.severity ?? ""), taxonomy_nodes: Array.isArray(r.data.taxonomy_nodes) ? (r.data.taxonomy_nodes as string[]) : [], description: String(r.data.description ?? "") }));
  const recorded = rt.store.list(EXCEPTIONS).map((r) => r.data as unknown as ControlException);
  return exceptionRegister({ findings, recorded });
}
/** The recorded applicability determination of an investor program (rule 18.6-1) as `investor_program.create` stored it. */
function recordedProgram(rt: ToolRuntime, id: string): RecordedProgram | null {
  const d = rt.store.get("investor_programs", id)?.data as { program_kind?: string; psa_deliverable_due?: { assessment_days?: number | null; statement_days?: number | null }; usap_requested?: boolean; criteria_applicable?: string[]; partner_entity?: string | null } | undefined;
  if (!d || !PROGRAM_KINDS.includes(d.program_kind as ProgramKind)) return null;
  return { id, program_kind: d.program_kind as ProgramKind, psa_assessment_days: d.psa_deliverable_due?.assessment_days ?? null, psa_statement_days: d.psa_deliverable_due?.statement_days ?? null, usap_requested: d.usap_requested === true, criteria_applicable: d.criteria_applicable ?? [], partner_entity: d.partner_entity ?? null };
}
const reportFromStore = (rt: ToolRuntime, documentId: string): AuditorReportRecord | null => { const d = documentId ? rt.store.get("documents", documentId)?.data : undefined; return d ? { document_id: documentId, kind: String(d.kind ?? ""), sha256: d.sha256 ? String(d.sha256) : null, firm: d.firm ? String(d.firm) : null } : null; };
/** The investor program a custodial account belongs to: the account record's `program_id`, else the program listing the account in `custodial_account_ids`. */
function programOfAccount(store: EntityStore, accountId: string | null): { id: string; regab_applicable: boolean } | null {
  if (!accountId) return null;
  const acct = store.get("custodial_accounts", accountId)?.data;
  const pid = acct?.program_id ?? acct?.investor_program_id;
  const prog = (pid ? store.get("investor_programs", String(pid))?.data : undefined) ?? store.list("investor_programs", (d) => Array.isArray(d.custodial_account_ids) && (d.custodial_account_ids as unknown[]).includes(accountId))[0]?.data;
  return prog ? { id: String(prog.id ?? pid ?? ""), regab_applicable: prog.regab_applicable === true } : null;
}

/** The whole 18.6 tool surface (see the header for why the bus slice below may be narrower). */
export const ATTESTATION_TOOLS_18_6: readonly ToolDef[] = defineTools("18.6", AGENT, [
  // ---- applicability and the annual cycle ----------------------------------------------------------------------------
  { name: "investor_program.create", kind: "write", handler: compute((i, ctx, rt) => {
    need(i, "investor", "program_kind");
    const kind = str(i, "program_kind"); if (!PROGRAM_KINDS.includes(kind as ProgramKind)) throw new RangeError(`program_kind ${kind} is not one of ${PROGRAM_KINDS.join(", ")}`);
    const a = regAbApplicability({ program_kind: kind as ProgramKind, usap_requested: flag(i, "usap_requested") });
    const id = str(i, "id") || `program-${rt.store.list("investor_programs").length + 1}`;
    const rec = rt.store.put("investor_programs", id, { id, investor: str(i, "investor"), program_kind: kind, regab_applicable: a.regab_applicable, usap_requested: flag(i, "usap_requested"), psa_deliverable_due: { assessment_days: optNum(i, "psa_assessment_days"), statement_days: optNum(i, "psa_statement_days") }, criteria_applicable: list<string>(i, "criteria_applicable"), custodial_account_ids: list<string>(i, "custodial_account_ids"), partner_entity: str(i, "partner_entity") || null, applicability_basis: a.basis, deliverables: a.deliverables }, ctx.actor, ctx.now);
    ctx.events.append({ type: "investor_program.created", aggregate: { kind: "investor_program", id }, actor: ctx.actor, payload: { program_id: id, program_kind: kind, regab_applicable: a.regab_applicable, usap_contractual: a.usap_contractual, regab_timers: a.regab_timers } });
    return { ...rec.data, regab_timers: a.regab_timers };
  }) },
  { name: "attestation.cycle.open", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "entity", "fye", "program_id");
    // prerequisite: the applicability determination is *recorded* per investor/pool (rule 18.6-1, at onboarding) — the cycle reads it and refuses a caller's restatement that conflicts with it
    const stored = recordedProgram(rt, str(i, "program_id"));
    if (!stored) throw new RangeError(`no investor_programs ${str(i, "program_id")} — investor_program.create records the applicability determination first (rule 18.6-1)`);
    const conflicts = applicabilityConflicts(stored, { program_kind: str(i, "program_kind") || null, psa_assessment_days: optNum(i, "psa_assessment_days"), psa_statement_days: optNum(i, "psa_statement_days"), usap_requested: i.usap_requested === undefined || i.usap_requested === null ? null : flag(i, "usap_requested"), criteria_scope: list<string>(i, "criteria_scope") });
    if (conflicts.length) throw new RangeError(`attestation.cycle.open reads the recorded determination, never the caller's: ${conflicts.join("; ")}`);
    const ev = attestationCycleEvent({ entity: str(i, "entity"), fye: date(i, "fye"), period_start: optDate(i, "period_start"), program: { id: stored.id, program_kind: stored.program_kind, psa_assessment_days: stored.psa_assessment_days, psa_statement_days: stored.psa_statement_days, usap_requested: stored.usap_requested } });
    ctx.events.append({ type: ev.type, aggregate: ev.aggregate, actor: ctx.actor, payload: ev.payload });
    const scope = [...stored.criteria_applicable];
    for (const k of ev.applicability.deliverables) rt.store.put("attestation_packages", `${ev.payload.cycle_id}:${k}`, { id: `${ev.payload.cycle_id}:${k}`, cycle_id: ev.payload.cycle_id, entity: ev.payload.entity, program_id: ev.payload.program_id, partner_entity: stored.partner_entity, fiscal_year: Number(ev.payload.fye.slice(0, 4)), period_start: ev.payload.period_start, period_end: ev.payload.period_end, kind: k, status: "planned", criteria_scope: scope, material_noncompliance: [], exceptions: [] }, ctx.actor, ctx.now);
    return { cycle_id: ev.payload.cycle_id, program_kind: stored.program_kind, regab_applicable: ev.applicability.regab_applicable, regab_timers: ev.applicability.regab_timers, deliverables: ev.applicability.deliverables, period: { start: ev.payload.period_start, end: ev.payload.period_end }, clocks: ev.clocks };
  }) },
  // ---- the control matrix, evidence, QC results, timer histories, document export -----------------------------------
  { name: "control_matrix.upsert", kind: "write", handler: compute((i, ctx, rt) => {
    const rows = list<MatrixRow & { description?: string; owner_agent?: string; evidence_query?: string; qc_rule_codes?: string[]; key?: boolean }>(i, "rows");
    if (rows.length === 0) throw new RangeError("rows is required (control_matrix rows: criterion, control_code, frequency, …)");
    const out = rows.map((r) => {
      if (!r.criterion || !r.control_code) throw new RangeError("every control_matrix row names its criterion and control_code");
      if (r.frequency !== undefined && !["monthly", "quarterly", "annual", "event"].includes(r.frequency)) throw new RangeError(`frequency ${String(r.frequency)} is monthly, quarterly, annual or event`);
      const id = `${r.criterion}:${r.control_code}`; const prev = rt.store.get("control_matrix", id);
      return rt.store.put("control_matrix", id, { ...r, version: (Number(prev?.data.version ?? 0) || 0) + 1, effective_from: str(i, "effective_from") || ctx.now.slice(0, 10) }, ctx.actor, ctx.now).data;
    });
    ctx.events.append({ type: "control_matrix.updated", actor: ctx.actor, payload: { rows: out.length, control_codes: out.map((r) => String(r.control_code)) } });
    return { rows: out };
  }) },
  { name: "control_evidence.generate", kind: "write", handler: compute((i, ctx, rt) => {
    const pkg = str(i, "package_id") ? requirePackage(rt, str(i, "package_id")) : null;
    const period_start = optDate(i, "period_start") ?? pkg?.period_start ?? null, period_end = optDate(i, "period_end") ?? pkg?.period_end ?? null;
    if (!period_start || !period_end) { need(i, "period_start", "period_end"); throw new RangeError("period_start and period_end are required"); }
    // the matrix is the one on file: a package binder is always generated from `control_matrix` (in the package's scope) — an inline `matrix` is only for an ad-hoc window with no package (an auditor sample request) and never reaches the evidence gate, which reads the stored matrix
    const inline = list<MatrixRow>(i, "matrix");
    if (pkg && inline.length) throw new RangeError(`a package binder is generated from the control_matrix on file, never from a caller's inline matrix (SM_ATTEST_EVIDENCE_COMPILE_FYE_15: complete for all matrix rows) — control_matrix.upsert first`);
    const matrix = inline.length ? inline : matrixRows(rt).filter((m) => !pkg?.criteria_scope?.length || pkg.criteria_scope.includes(m.criterion));
    if (matrix.length === 0) throw new RangeError("no control_matrix rows on file — control_matrix.upsert the 1122(d) control matrix before generating evidence");
    const evidence = list<{ control_code: string; occurred_on: string; document_id: string; exception?: boolean }>(i, "evidence").map((e) => ({ ...e, occurred_on: D(e.occurred_on) }));
    // evidence is documents on file, with their hashes (Integrations: exports with hashes; Audit: evidence binders with hashes) — a document id nobody filed is not evidence
    const docs = evidenceDocumentsOnFile(evidence, rt.store.list("documents").map((r) => ({ id: String(r.data.id ?? r.id), sha256: r.data.sha256 ? String(r.data.sha256) : null })));
    if (docs.missing.length) throw new RangeError(`evidence cites documents not on file: ${docs.missing.join(", ")} — file each evidence document (documents) before it can be cited in the binder`);
    const binder = controlEvidenceBinder({ period_start, period_end, matrix, evidence, supermortgage_fye: optDate(i, "supermortgage_fye") ?? D(`${period_end.slice(0, 4)}-12-31`) });
    const period = `${binder.period.start}..${binder.period.end}`;
    const rows = binder.rows.map((r) => ({ ...r, evidence_document_sha256: r.evidence_document_ids.map((id) => docs.sha256[id] ?? null) }));
    for (const r of rows) rt.store.put("control_evidence", `${r.control_code}:${period}:${ctx.now}`, { control_code: r.control_code, criterion: r.criterion, period_start: binder.period.start, period_end: binder.period.end, package_id: pkg?.id ?? null, evidence_document_ids: r.evidence_document_ids, evidence_document_sha256: r.evidence_document_sha256, exceptions_count: r.exceptions_count, expected_count: r.expected_count, missing_periods: r.missing_periods, complete: r.complete, generated_at: ctx.now }, ctx.actor, ctx.now);
    const cycleId = str(i, "cycle_id") || pkg?.cycle_id || "";
    ctx.events.append({ type: "control_evidence.generated", ...(cycleId ? { aggregate: { kind: "attestation_cycle", id: cycleId } } : {}), actor: ctx.actor, payload: { period_start: binder.period.start, period_end: binder.period.end, package_id: pkg?.id ?? null, matrix_source: inline.length ? "inline" : "control_matrix", complete: binder.complete, incomplete_controls: binder.incomplete_controls } });
    return { ...binder, rows, matrix_source: inline.length ? "inline" as const : "control_matrix" as const };
  }) },
  { name: "qc_results.query", kind: "read", handler: compute((i, _c, rt) => rt.store.list("qc_findings", (d) => (!str(i, "criterion") || (Array.isArray(d.taxonomy_nodes) && (d.taxonomy_nodes as string[]).some((n) => n.endsWith(str(i, "criterion"))))) && (!str(i, "severity") || d.severity === str(i, "severity"))).map((r) => r.data)) },
  { name: "timers.history", kind: "read", handler: compute((i, ctx) => ctx.timers.all().filter((t) => (!str(i, "code") || t.code === str(i, "code")) && (!str(i, "subject_id") || t.subject.id === str(i, "subject_id"))).map((t) => ({ id: t.id, code: t.code, subject: t.subject, status: t.status, anchor_date: t.anchorDate, due_date: t.dueDate ?? null, armed_at: t.armedAt, satisfied_at: t.satisfiedAt ?? null, breached_at: t.breachedAt ?? null }))) },
  { name: "documents.export", kind: "read", handler: compute((i, _c, rt) => { const ids = list<string>(i, "document_ids"); return { exported_for: str(i, "audience") || "auditor", documents: rt.store.list("documents", (d) => ids.length === 0 || ids.includes(String(d.id ?? ""))).map((r) => ({ id: r.id, sha256: r.data.sha256 ?? null, kind: r.data.kind ?? null })), read_only: true }; }) },
  // ---- drafts: the agent renders, the officer signs -------------------------------------------------------------------
  { name: "letter.render", kind: "act", handler: compute((i, _c, rt) => {
    need(i, "template");
    const t = str(i, "template");
    if (t === "ATTEST-1122-ASSERT-v1") {
      // rule 18.6-3 by construction: the assessment is rendered from the package's stored officer determinations — a caller may add an item, never leave one out
      need(i, "package_id"); const pkg = requirePackage(rt, str(i, "package_id"));
      const stored = pkg.material_noncompliance ?? []; const extra = list<MaterialNoncomplianceItem>(i, "material_noncompliance").filter((x) => !stored.some((s) => s.criterion === x.criterion && s.description === x.description && s.determined_on === x.determined_on));
      const period_start = optDate(i, "period_start") ?? pkg.period_start ?? null, period_end = optDate(i, "period_end") ?? pkg.period_end ?? null; const entity = str(i, "entity") || pkg.entity || "";
      if (!entity || !period_start || !period_end) throw new RangeError("entity, period_start and period_end are required (or a package carrying them)");
      const r = assessmentReport({ entity, period_start, period_end, criteria_scope: list<string>(i, "criteria_scope").length ? list<string>(i, "criteria_scope") : (pkg.criteria_scope ?? []), inapplicable_criteria: list<{ criterion: string; rationale: string }>(i, "inapplicable_criteria"), material_noncompliance: [...stored, ...extra], attestation_firm: str(i, "attestation_firm") || reportFromStore(rt, String(pkg.auditor_report_document_id ?? ""))?.firm || null });
      return { template: t, package_id: pkg.id, status: "draft_unsigned", signature_required_from: "officer", items_from_package: stored.length, ...r };
    }
    if (t === "ATTEST-1123-SUBCERT-v1") { need(i, "entity", "partner_entity", "period_start", "period_end"); return { template: t, status: "draft_unsigned", ...subCertification({ entity: str(i, "entity"), partner_entity: str(i, "partner_entity"), period_start: date(i, "period_start"), period_end: date(i, "period_end"), psa_obligations: list<string>(i, "psa_obligations"), known_failures: list<{ obligation: string; nature: string; status: string }>(i, "known_failures") }) }; }
    throw new RangeError(`template ${t} is not ATTEST-1122-ASSERT-v1 or ATTEST-1123-SUBCERT-v1`);
  }), guardrails: [never("REGAB_AGENT_NEVER_SIGNS", "18.6 guardrail: the agent never signs or asserts; management assertions and 1123 statements are officer acts (baseline §8 item 3)", (i) => flag(i, "sign") || flag(i, "assert") || flag(i, "signed"), "the renderer produces an unsigned draft only — the officer signs through attestation_package.transition")] },
  // ---- exceptions ------------------------------------------------------------------------------------------------------
  // one register for every package: `package_id` is echoed for the agent's decision record `{package_id, criterion, …, exceptions[]}` and never narrows the list
  { name: "control_exceptions.list", kind: "read", handler: compute((i, _c, rt) => { const r = registerFromStore(rt); return { package_id: str(i, "package_id") || null, scope: "every package (the register is never scoped by package)", register: r.register, open: r.open.length, open_ids: r.open.map((x) => x.finding_id) }; }) },
  { name: "control_exception.record", kind: "write", handler: compute((i, ctx, rt) => {
    need(i, "criterion", "source", "description");
    const source = str(i, "source"); if (source !== "finding" && source !== "timer_breach") throw new RangeError("source is finding or timer_breach");
    const ex: ControlException = source === "finding"
      ? controlExceptions({ findings: [{ id: str(i, "finding_id") || str(i, "id"), severity: str(i, "severity") || "sev1", taxonomy_nodes: [str(i, "criterion")], description: str(i, "description") }] })[0]!
      : controlExceptions({ timer_breaches: [{ timer_code: str(i, "timer_code"), subject_id: str(i, "subject_id") || str(i, "id"), criterion: str(i, "criterion"), description: str(i, "description"), severity: str(i, "severity") || "sev2" }] })[0]!;
    if (!ex) throw new RangeError(`criterion ${str(i, "criterion")} is not a 1122(d) criterion`);
    // append-only register: a recorded row (the reactor's timer breach, or an earlier record) is never re-recorded — re-recording could re-tag, re-open or re-describe it; it leaves the open list only on an officer disposition
    const prior = rt.store.get(EXCEPTIONS, ex.finding_id);
    if (prior) throw new RangeError(`exception ${ex.finding_id} is already on the register (recorded ${String(prior.data.recorded_at ?? "")}, ${String(prior.data.status ?? "")}) — the register is append-only; an exception leaves it only on an officer disposition`);
    const rec = rt.store.put(EXCEPTIONS, ex.finding_id, { ...ex, source, recorded_by: `${ctx.actor.kind}:${ctx.actor.id}`, recorded_at: ctx.now }, ctx.actor, ctx.now);
    ctx.events.append({ type: "control.exception.recorded", ...(str(i, "cycle_id") ? { aggregate: cycleAggregate(i) } : {}), actor: ctx.actor, payload: { exception_id: ex.finding_id, criterion: ex.criterion, source, severity: ex.severity, ...(source === "timer_breach" ? { timer_code: str(i, "timer_code") } : {}) } });
    return rec.data;
  }) },
  { name: "exception.disposition", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "exception_id", "officer_id", "rationale");
    const id = str(i, "exception_id");
    // the exception must be on the register: a recorded regab_control_exceptions row, or a qc_findings row tagged to a criterion — never a row conjured for the disposition
    const recorded = rt.store.get(EXCEPTIONS, id)?.data as ControlException | undefined;
    const finding = recorded ? null : rt.store.list("qc_findings", (d) => String(d.id ?? "") === id)[0] ?? rt.store.get("qc_findings", id);
    const fromFinding = finding ? exceptionList({ findings: [{ id, severity: String(finding.data.severity ?? ""), taxonomy_nodes: Array.isArray(finding.data.taxonomy_nodes) ? (finding.data.taxonomy_nodes as string[]) : [], description: String(finding.data.description ?? "") }] })[0] ?? null : null;
    const ex = recorded ?? fromFinding; if (!ex) throw new RangeError(`exception ${id} is not on the exception register (no regab_control_exceptions row and no qc_findings row tagged to a 1122(d) criterion)`);
    const r = removeException({ exception: ex, officer_disposition: { officer_id: str(i, "officer_id"), rationale: str(i, "rationale") } });
    if (!r.removed) return { dispositioned: false, refusal: r.refusal };
    // the disposition is the officer's act on the exception itself — it holds for every package (the register is never scoped by package)
    const rec = rt.store.put(EXCEPTIONS, ex.finding_id, { ...ex, ...(recorded ? {} : { source: "finding", recorded_by: `${ctx.actor.kind}:${ctx.actor.id}`, recorded_at: ctx.now }), status: "dispositioned", officer_disposition: { officer_id: str(i, "officer_id"), disposition: str(i, "rationale") }, dispositioned_at: ctx.now }, ctx.actor, ctx.now);
    ctx.events.append({ type: "control.exception.dispositioned", actor: ctx.actor, payload: { exception_id: ex.finding_id, criterion: ex.criterion, officer_id: str(i, "officer_id"), package_id: str(i, "package_id") || null } });
    return { dispositioned: true, refusal: null, exception: rec.data };
  }), guardrails: [needsRole("REGAB_EXCEPTION_OFFICER_DISPOSITION", "18.6 guardrail: every 18.1 finding tagged to a criterion appears in the exception list until dispositioned by the officer", () => true, ["officer"], "an exception leaves the list only on an officer disposition"),
    never("REGAB_EXCEPTION_RATIONALE", "18.6-T3: cannot be removed without an officer disposition (with rationale)", (i) => !str(i, "rationale").trim(), "the disposition must state its rationale")] },
  // ---- the state machine (18.6-T7) -------------------------------------------------------------------------------------
  { name: "attestation_package.transition", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "package_id", "to");
    const to = str(i, "to") as PackageStatus; if (!PACKAGE_STATES.includes(to)) throw new RangeError(`to ${to} is not a package status`);
    const cur = requirePackage(rt, str(i, "package_id"));
    const from = cur.status; if (str(i, "from") && str(i, "from") !== from) throw new RangeError(`from ${str(i, "from")} is not the package's stored status ${from} — the state machine reads the stored status, never the caller's`);
    const evidence = to === "evidence_compiled" ? evidenceFromStore(rt, cur) : null;
    const open = to === "exceptions_evaluated" ? registerFromStore(rt).open : [];
    const reportId = to === "attestation_received" ? (str(i, "auditor_report_document_id") || String(cur.auditor_report_document_id ?? "")) : "";
    const report = reportId ? reportFromStore(rt, reportId) : null;
    const r = packageTransition({ package_id: cur.id, kind: cur.kind, from, to, actor: { kind: ctx.actor.kind, role: ctx.actor.role ?? null }, signature: signatureOf(i), evidence, open_exceptions: open.length, material_noncompliance_count: cur.material_noncompliance?.length ?? 0, auditor_report: report, delivered_to: str(i, "delivered_to") || null });
    if (!r.allowed) return { ...r, ...(evidence ? { evidence } : {}), ...(open.length ? { open_exceptions: open.map((x) => x.finding_id) } : {}) };
    const sig = signatureOf(i);
    rt.store.put("attestation_packages", cur.id, { status: to, ...(to === "assertion_signed" && sig ? { signed_by_officer_id: sig.officer_id, signed_by_role: "officer", signed_at: sig.signed_at, management_assertion_document_id: sig.document_id } : {}), ...(to === "attestation_received" && report ? { auditor_report_document_id: report.document_id } : {}), ...(to === "delivered" ? { delivered_to: str(i, "delivered_to"), delivered_at: ctx.now } : {}) }, ctx.actor, ctx.now);
    const aggregate = { kind: "attestation_cycle" as const, id: str(i, "cycle_id") || cur.cycle_id || cur.id };
    for (const e of r.events) ctx.events.append({ type: e.type, aggregate, actor: ctx.actor, payload: e.payload });
    return r;
  }), guardrails: [
    humanWhen("REGAB_AGENT_NEVER_SIGNS", "18.6 guardrail: the agent never signs or asserts; management assertions and 1123 statements are officer acts (baseline §8 item 3: \"Reg AB/USAP attestation\")", (i) => str(i, "to") === "assertion_signed", "assertion_signed is an officer act — the agent prepares the draft and escalates to the officer"),
    needsRole("REGAB_ASSERTION_OFFICER_ONLY", "18.6 timer table: SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45 satisfied by 'assertion signed by `officer`'", (i) => str(i, "to") === "assertion_signed", ["officer"], "only the officer records the management assertion"),
    never("REGAB_ASSERTION_SIGNATURE_RECORD", "18.6-T7: marking a package assertion_signed without an officer signature record is refused", (i) => str(i, "to") === "assertion_signed" && !officerSignatureRecord(signatureOf(i)).present, "the transition is refused without an officer signature record (officer_id, signer_role officer, signed_at, document_id)"),
  ] },
  // ---- material noncompliance and the partner --------------------------------------------------------------------------
  { name: "material_noncompliance.determine", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "cycle_id", "criterion", "description", "determined_on");
    const d = materialNoncomplianceDisclosure({ determined_on: date(i, "determined_on"), criterion: str(i, "criterion"), description: str(i, "description"), determined_by_role: ctx.actor.role ?? ctx.actor.kind, counsel_advice_document_id: str(i, "counsel_advice_document_id") || null, involves_pool_asset_servicing: i.involves_pool_asset_servicing !== false });
    if (!d.allowed || !d.item) return d;
    const pkgId = str(i, "package_id"); const cur = pkgId ? rt.store.get("attestation_packages", pkgId)?.data : undefined;
    if (pkgId) rt.store.put("attestation_packages", pkgId, { ...(cur ?? { id: pkgId }), material_noncompliance: [...((cur?.material_noncompliance as unknown[] | undefined) ?? []), d.item] }, ctx.actor, ctx.now);
    ctx.events.append({ type: "material_noncompliance.determined", aggregate: cycleAggregate(i), actor: ctx.actor, payload: { determination: d.item.determined_on, criterion: d.item.criterion, description: d.item.description, counsel_advice_document_id: str(i, "counsel_advice_document_id"), involves_pool_asset_servicing: d.item.involves_pool_asset_servicing, partner_notice_due: d.timer!.due } });
    return d;
  }), guardrails: [needsRole("REGAB_MATERIALITY_OFFICER", "18.6 rule 3: a material instance of noncompliance is determined by the officer on counsel's advice using the auditor's materiality framework", () => true, ["officer"], "materiality is an officer determination — the agent drafts the materiality memo and escalates"),
    never("REGAB_MATERIALITY_COUNSEL_ADVICE", "18.6 rule 3: determined by the officer on counsel's advice", (i) => !str(i, "counsel_advice_document_id").trim(), "record counsel's advice document before determining material noncompliance")] },
  { name: "partner.notify", kind: "act", handler: compute((i, ctx) => {
    need(i, "cycle_id", "reason");
    ctx.events.append({ type: "partner.notified", aggregate: cycleAggregate(i), actor: ctx.actor, payload: { reason: str(i, "reason"), criterion: str(i, "criterion") || null, description: str(i, "description") || null, notified_on: (optDate(i, "notified_on") ?? D(ctx.now.slice(0, 10))), channel: str(i, "channel") || "secure_transfer" } });
    return { notified: true, reason: str(i, "reason"), cycle_id: str(i, "cycle_id") };
  }), guardrails: [never("REGAB_PARTNER_NOTICE_SCOPE", "18.6 prerequisites: sharing of material noncompliance immediately; delivery of assessments and sub-certifications; findings after delivery → supplemental disclosure", (i) => !PARTNER_REASONS.includes(str(i, "reason")), `partner notices under 18.6 are for ${PARTNER_REASONS.join(", ")}`)] },
  { name: "attestation_report.receive", kind: "write", handler: compute((i, ctx, rt) => {
    // Integrations: "report receipt to `documents`" — the accountant's report is a document with its hash from a named registered public accounting firm, never a bare id
    need(i, "cycle_id", "kind", "document_id", "sha256", "firm");
    const kind = str(i, "kind") as PackageKind; if (!REPORT_KIND[kind]) throw new RangeError("kind is regab_1122_assessment, soc1_type2 or usap (the 1123 statement has no accountant's report)");
    rt.store.put("documents", str(i, "document_id"), { id: str(i, "document_id"), kind: REPORT_KIND[kind], sha256: str(i, "sha256"), firm: str(i, "firm"), cycle_id: str(i, "cycle_id"), received_at: ctx.now, retention: "corporate_7y" }, ctx.actor, ctx.now);
    const pkgId = str(i, "package_id"); if (pkgId) { const cur = rt.store.get("attestation_packages", pkgId)?.data; rt.store.put("attestation_packages", pkgId, { ...(cur ?? { id: pkgId, kind }), auditor_report_document_id: str(i, "document_id") }, ctx.actor, ctx.now); }
    const received = ctx.events.append({ type: "attestation.report.received", aggregate: cycleAggregate(i), actor: ctx.actor, payload: { kind, soc1: kind === "soc1_type2", document_id: str(i, "document_id"), sha256: str(i, "sha256"), firm: str(i, "firm"), package_id: pkgId || null } });
    // SM_SOC1_TYPE2_ANNUAL is a *recurring* row, so the kernel re-arms it on satisfaction — anchored on the receipt (the receipt carries no `fye`),
    // which is not the timer table's anchor ('fiscal year' / FYE + 75). The annual recurrence is carried by the next fiscal year's
    // `attestation.cycle.opened`, which arms its own FYE-anchored instance (timers-18-6.ts), so the receipt-anchored re-arm is cancelled here, with the reason on the record.
    const reArmed = ctx.timers.byCode("SM_SOC1_TYPE2_ANNUAL").filter((t) => t.status === "armed" && t.armedByEventId === received.id);
    for (const t of reArmed) ctx.timers.cancel(t.id, "SM_SOC1_TYPE2_ANNUAL recurs per fiscal year (anchor FYE, report by FYE + 75): the next fiscal year's attestation.cycle.opened arms its own FYE-anchored instance; the receipt-anchored re-arm is not a fiscal-year clock (18.6 timer table)", ctx.actor);
    return { received: true, kind, soc1: kind === "soc1_type2", document_id: str(i, "document_id"), sha256: str(i, "sha256"), event_id: received.id, recurrence_re_arm_cancelled: reArmed.map((t) => t.id) };
  }) },
  // ---- the FYE + 30 warning of REGAB_1122_ASSESSMENT_PSA_DUE ---------------------------------------------------------------
  { name: "attestation.warning.check", kind: "act", handler: compute((i, ctx, rt) => {
    const asOf = date(i, "as_of");
    const raised = new Set(ctx.events.ofType("attestation.warning.raised").map((e) => String(e.payload.cycle_id)));
    const cycles = ctx.events.ofType("attestation.cycle.opened").filter((e) => e.payload.regab_applicable === true).map((c) => {
      const cycleId = String(c.payload.cycle_id); const pkg = rt.store.get("attestation_packages", `${cycleId}:regab_1122_assessment`)?.data;
      const warning_on = D(String(c.payload.warning_on)), due = D(String(c.payload.psa_assessment_due));
      const w = assessmentWarning({ warning_on, due, as_of: asOf, delivered: pkg?.status === "delivered" || pkg?.status === "closed", already_raised: raised.has(cycleId) });
      if (!w.raise) return { cycle_id: cycleId, raised: false, reason: w.reason };
      const esc = rt.escalations.open({ kind: "officer", severity: "warning", payload: { code: "REGAB_1122_ASSESSMENT_PSA_DUE", cycle_id: cycleId, warning_on, due, partner: pkg?.partner_entity ?? null, reason: w.reason } }, ctx.actor);
      ctx.events.append({ type: "attestation.warning.raised", aggregate: { kind: "attestation_cycle", id: cycleId }, actor: ctx.actor, payload: { code: "REGAB_1122_ASSESSMENT_PSA_DUE", cycle_id: cycleId, warning_on, due, escalation_id: esc.id } });
      raised.add(cycleId);
      return { cycle_id: cycleId, raised: true, escalation_id: esc.id, reason: w.reason };
    });
    return { as_of: asOf, cycles };
  }) },
  { name: "escalations.create", kind: "act", handler: escalate("officer") },
]);

/**
 * The attestation module's event subscribers (wired where the app builds its unit of work; the spec test wires them on its bus):
 *   §6.3 `reconciliation_item.opened` → `regab.reconciling_item.opened{item_id, account_id, item_date, program_id, regab_applicable}`
 *     on the item's own aggregate `regab_reconciling_item` (classifyReconItem) — the trigger of REGAB_1122_2VII_RECON_ITEMS_90 when
 *     `regab_applicable=true`; one clock per item, never one per account;
 *   §6.3 `reconciliation_item.resolved{item_id, status}` (on the account aggregate, or on none) → `regab.reconciling_item.resolved{status}`
 *     on that item's aggregate (reconItemResolvedView) — the clock's satisfier, for items the module classified as applicable;
 *   `timer.breached{code=REGAB_1122_2VII_RECON_ITEMS_90}` → the control exception for 1122(d)(2)(vii) recorded on the register
 *     (reconItemControlException; 18.6-T4 "then a control exception is recorded"), open until the officer dispositions it.
 * Returns the unsubscribe function.
 */
export function attestationReactors_18_6(deps: { events: EventStore; timers: TimerEngine; store: EntityStore }): () => void {
  const itemIdOf = (e: DomainEvent): string => { const p = e.payload as Record<string, unknown>; return String(p.item_id ?? p.file_id ?? p.reconciliation_item_id ?? e.aggregate?.id ?? e.id); };
  const offItem = deps.events.subscribe("reconciliation_item.opened", (e) => {
    const p = e.payload as Record<string, unknown>;
    const account_id = typeof p.account_id === "string" ? p.account_id : e.aggregate?.kind === "custodial_account" ? e.aggregate.id : null;
    const item_id = itemIdOf(e);
    const stated = typeof p.regab_applicable === "boolean" ? { id: String(p.program_id ?? "(stated on the item)"), regab_applicable: p.regab_applicable } : null;
    const firstSeen = typeof p.item_date === "string" ? p.item_date : typeof p.first_seen_on === "string" ? p.first_seen_on : null;
    const d = classifyReconItem({ source_event_id: e.id, item_id, account_id, first_seen_on: firstSeen && /^\d{4}-\d{2}-\d{2}$/.test(firstSeen) ? D(firstSeen) : null, event_date: D(e.occurredAt.slice(0, 10)), program: stated ?? programOfAccount(deps.store, account_id) });
    deps.events.append({ type: d.type, ...(e.loanId ? { loanId: e.loanId } : {}), aggregate: d.aggregate, actor: SYSTEM, causationId: e.id, occurredAt: e.occurredAt, payload: d.payload });
  });
  const offResolved = deps.events.subscribe("reconciliation_item.resolved", (e) => {
    const p = e.payload as Record<string, unknown>;
    const item_id = itemIdOf(e);
    const opened = deps.events.ofType("regab.reconciling_item.opened").find((x) => String(x.payload.item_id) === item_id && x.payload.regab_applicable === true);
    const d = reconItemResolvedView({ source_event_id: e.id, item_id, account_id: typeof p.account_id === "string" ? p.account_id : typeof opened?.payload.account_id === "string" ? opened.payload.account_id : e.aggregate?.kind === "custodial_account" ? e.aggregate.id : null, status: String(p.status ?? ""), tracked: opened !== undefined });
    if (d) deps.events.append({ type: d.type, ...(e.loanId ? { loanId: e.loanId } : {}), aggregate: d.aggregate, actor: SYSTEM, causationId: e.id, occurredAt: e.occurredAt, payload: d.payload });
  });
  const offBreach = deps.events.subscribe("timer.breached{code=REGAB_1122_2VII_RECON_ITEMS_90}", (e) => {
    const inst = deps.timers.all().find((t) => t.id === String(e.payload.timer_id)); if (!inst) return;
    const armedBy = deps.events.all().find((x) => x.id === inst.armedByEventId); const p = (armedBy?.payload ?? {}) as Record<string, unknown>;
    const item_id = String(p.item_id ?? inst.subject.id);
    const x = reconItemControlException({ item_id, item_date: inst.anchorDate, as_of: D((inst.breachedAt ?? e.occurredAt).slice(0, 10)), account_id: typeof p.account_id === "string" ? p.account_id : null });
    if (!x.exception || deps.store.get(EXCEPTIONS, x.exception.finding_id)) return;
    deps.store.put(EXCEPTIONS, x.exception.finding_id, { ...x.exception, source: "timer_breach", timer_code: inst.code, timer_id: inst.id, account_id: p.account_id ?? null, program_id: p.program_id ?? null, recorded_by: `${SYSTEM.kind}:${SYSTEM.id}`, recorded_at: inst.breachedAt ?? e.occurredAt }, SYSTEM, inst.breachedAt ?? e.occurredAt);
    deps.events.append({ type: "control.exception.recorded", ...(armedBy?.aggregate ? { aggregate: armedBy.aggregate } : {}), actor: SYSTEM, causationId: e.id, payload: { exception_id: x.exception.finding_id, criterion: x.exception.criterion, source: "timer_breach", severity: x.exception.severity, timer_code: inst.code, timer_id: inst.id, item_id, aged_days: x.aged_days } });
  });
  return () => { offItem(); offResolved(); offBreach(); };
}

const SPEC_NAMES = new Set(loadAgentsFile().processes.find((p) => p.process === "18.6")?.tools ?? []);
/** The bus slice: every 18.6 tool whose name spec/registry/agents.json lists for 18.6 (see the header). */
export const TOOLS_18_6: readonly ToolDef[] = ATTESTATION_TOOLS_18_6.filter((t) => SPEC_NAMES.has(t.name));
