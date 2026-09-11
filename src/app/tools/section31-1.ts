/**
 * §31.1 process-owned tools — bus tools for 31.1 defined with `defineTools("31.1", "compliance-sentinel", defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 31.1; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The licensing persona's paragraph (spec "AI agent design"): `nmls.sync`, `licenses.upsert` (status only from evidence),
 * `matrix.propose` (drafts `license_requirements` rows from statute text with citations; never sets `verified` — counsel
 * does), `readiness.compute(state)`, `roster.recompute`, `roster.reassign(mlo_id)`, `approvals.upsert` (from evidence),
 * `eligibility.computeOrigInputs(period)`, `packages.form582SellerSide`, `packages.tpoQuarterly`, `portal_task.create`,
 * `timers.read`, `escalations.open`. The registry counts the five strings its extractor kept (`nmls.sync`,
 * `licenses.upsert`, `matrix.propose`, `license_requirements`, `verified`), so the rest of the paragraph rides on them
 * as `op`s: nmls.sync{op=sync|readiness|roster.recompute|timers.read}; licenses.upsert{op=license|approval|
 * roster.reassign|eligibility|form582|tpo_quarterly|portal_task|escalate|warehouse_legal_form}; matrix.propose;
 * license_requirements (read: the matrix, RPT_STATE_READINESS); verified (counsel's act on a row — human only).
 * Guardrails encode the paragraph: never `approved`/`granted` without evidence; never a matrix row `verified`; never a
 * gate opened on inference or for an `unverified` processor rule; never an SM employee `assignable` as `mlo_of_record`;
 * never a switch of `origination.warehouse_legal_form`; never a filing with NMLS, a state or Fannie Mae.
 * State lives in the entity store (`licenses`, `license_requirements`, `mlo_roster`, `fnma_approvals`,
 * `ai_intake_legal_positions`, `eligibility_inputs_origination`, `tpo_program_reviews`); events go through ops-31-1.ts.
 */
import { defineTools, compute, never, needsRole, humanWhen, str, cents, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { EscalationKind } from "../escalations.ts";
import { assertStateGate, stateReadiness, stateReadinessReport, recomputeRoster, reassignInFlightApplications, upsertLicense, recordFnmaApproval, changeFnmaApprovalStatus, computeOrigInputs, form582SellerSideAnswers, tpoQuarterlyPackage, syncNmls, nightlySyncTick, proposeMatrixRow, verifyMatrixRow, setWarehouseLegalForm, deriveJurisdictionLicensing, proposeMloOfRecord, EVIDENCED_STATUSES, WAREHOUSE_LEGAL_FORM_KEY,
  type License, type LicenseInput, type LicenseRequirement, type JurisdictionLicensing, type MloRosterMember, type FnmaApproval, type AiIntakeLegalPosition, type NmlsRecord, type ReadinessFacts, type InFlightApplication, type MatrixDraft, type WarehouseLegalForm } from "../../domain/governance/ops-31-1.ts";

/** Missing-input refusals are RangeErrors (never TypeErrors) — src/app/tools.test.ts executes every tool with `{}`. */
const need = (i: ToolInput, ...keys: string[]): void => { const missing = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (missing.length) throw new RangeError(`31.1 tool needs ${missing.join(", ")}`); };
const dateIn = (i: ToolInput, k: string): PlainDate => D(str(i, k));
const asOf = (i: ToolInput, ctx: CommandContext): PlainDate => (i.as_of ? dateIn(i, "as_of") : D(ctx.now.slice(0, 10)));
const rows = <T>(i: ToolInput, k: string, rt: ToolRuntime, kind: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : rt.store.list(kind).map((r) => r.data as unknown as T));
const jurisdictionOf = (i: ToolInput, rt: ToolRuntime, state: string, on: PlainDate): JurisdictionLicensing => {
  if (i.jurisdiction && typeof i.jurisdiction === "object") return i.jurisdiction as JurisdictionLicensing;
  const reqs = rows<LicenseRequirement>(i, "license_requirements", rt, "license_requirements");
  const pos = rows<AiIntakeLegalPosition>(i, "ai_intake_legal_positions", rt, "ai_intake_legal_positions").find((p) => p.jurisdiction === state) ?? null;
  return deriveJurisdictionLicensing(state, reqs, pos, on);
};
const readinessFacts = (i: ToolInput, ctx: CommandContext, rt: ToolRuntime, state: string): ReadinessFacts => {
  const on = asOf(i, ctx);
  return { state, as_of: on, licenses: rows<License>(i, "licenses", rt, "licenses"), jurisdiction: jurisdictionOf(i, rt, state, on), roster: rows<MloRosterMember>(i, "roster", rt, "mlo_roster"), officer_risk_acceptance: (i.officer_risk_acceptance as ReadinessFacts["officer_risk_acceptance"]) ?? null };
};
const bigints = <T extends object>(o: T, keys: readonly string[]): T => { const out: Record<string, unknown> = { ...(o as Record<string, unknown>) }; for (const k of keys) if (out[k] !== undefined && out[k] !== null && typeof out[k] !== "bigint") out[k] = BigInt(String(out[k])); return out as unknown as T; };
const licenseIn = (i: ToolInput): LicenseInput => { const l = i.license as LicenseInput | undefined; if (!l || typeof l !== "object") throw new RangeError("31.1 tool needs license {license_id, holder_kind, holder_ref, jurisdiction, license_type_code, activity_scope, status?, evidence_document_id?, nmls_status_raw?}"); return bigints(l, ["bond_amount_cents"]); };
const NO_FILING = never("NO_FILING_BY_AGENT", "31.1 guardrails: may never file anything with NMLS, a state or Fannie Mae (humans file; the agent prepares)", (i) => i.op === "file" || i.file === true || i.submit_to_nmls === true || i.submit_to_regulator === true || i.submit_to_fnma === true, "the agent prepares checklists and packages; filings are human acts in NMLS, the state portal or Technology Manager");

export const TOOLS_31_1: readonly ToolDef[] = defineTools("31.1", "compliance-sentinel", [
  { name: "nmls.sync", kind: "act", handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "sync";
      if (op === "readiness") { need(i, "state"); return stateReadiness(readinessFacts(i, ctx, rt, str(i, "state"))); }
      if (op === "timers.read") return ctx.timers.open().filter((t) => !i.code || t.code === str(i, "code")).map((t) => ({ id: t.id, code: t.code, status: t.status, due_date: t.dueDate ?? null, subject: t.subject }));
      if (op === "roster.recompute") {
        const on = asOf(i, ctx); const licenses = rows<License>(i, "licenses", rt, "licenses");
        const members = rows<MloRosterMember>(i, "roster", rt, "mlo_roster");
        const states = [...new Set(members.flatMap((m) => m.state_licenses.map((id) => licenses.find((l) => l.license_id === id)?.jurisdiction).filter((s): s is string => !!s)))];
        const out = recomputeRoster(members, licenses, states.map((s) => jurisdictionOf(i, rt, s, on)), on);
        for (const m of out) rt.store.put("mlo_roster", m.mlo_id, { ...m }, ctx.actor, ctx.now);
        return { recomputed: out.length, roster: out };
      }
      if (op !== "sync") throw new RangeError(`nmls.sync op ${op} is not one of sync/readiness/roster.recompute/timers.read`);
      need(i, "records");
      if (!Array.isArray(i.records)) throw new RangeError("nmls.sync needs records[] (Consumer Access / B2B rows)");
      if (flag(i, "tick")) nightlySyncTick(ctx.events, { date: asOf(i, ctx), at: ctx.now });
      const r = syncNmls(ctx.events, rows<License>(i, "licenses", rt, "licenses"), i.records as NmlsRecord[], { at: ctx.now });
      for (const l of r.licenses) rt.store.put("licenses", l.license_id, { ...l }, ctx.actor, ctx.now);
      return { synced: r.licenses.length, changed: r.changed.length, not_found: r.not_found, event_id: r.event.id }; }),
    guardrails: [NO_FILING, never("GATE_NEVER_OPENED_ON_INFERENCE", "31.1 guardrails: may never open a state gate on inference or for an `unverified` processor rule", (i) => i.op === "readiness" && (i.force_open === true || i.assume_verified === true || i.infer === true), "readiness is computed from registry rows only")] },
  { name: "licenses.upsert", kind: "write", handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "license";
      switch (op) {
        case "license": {
          const input = licenseIn(i);
          const existing = (rt.store.get("licenses", input.license_id)?.data as unknown as License | undefined) ?? null;
          const r = upsertLicense(ctx.events, existing, { ...input, at: ctx.now, reason: (i.reason as string | undefined) ?? null });
          rt.store.put("licenses", r.license.license_id, { ...r.license }, ctx.actor, ctx.now);
          return { license: r.license, event_id: r.event?.id ?? null, org_change_event_id: r.org_change?.id ?? null };
        }
        case "approval": {
          const a = i.approval as Partial<FnmaApproval> | undefined; if (!a || typeof a !== "object") throw new RangeError("licenses.upsert{op=approval} needs approval {approval_id, entity, kind, product?, status, granted_at?, evidence_document_id}");
          const existing = a.approval_id ? (rt.store.get("fnma_approvals", a.approval_id)?.data as unknown as FnmaApproval | undefined) : undefined;
          const r = existing && a.status && a.status !== existing.status ? changeFnmaApprovalStatus(ctx.events, existing, { to: a.status, at: ctx.now, evidence_document_id: a.evidence_document_id ?? null, granted_at: a.granted_at ?? null }) : recordFnmaApproval(ctx.events, a as Parameters<typeof recordFnmaApproval>[1], ctx.now);
          rt.store.put("fnma_approvals", r.approval.approval_id, { ...r.approval }, ctx.actor, ctx.now);
          return { approval: r.approval, event_ids: r.events.map((e) => e.id) };
        }
        case "roster.reassign": {
          need(i, "mlo_id");
          const r = reassignInFlightApplications(ctx.events, { from_mlo_id: str(i, "mlo_id"), applications: (i.applications as InFlightApplication[] | undefined) ?? [], roster: rows<MloRosterMember>(i, "roster", rt, "mlo_roster"), at: ctx.now, reason: (i.reason as "nmls_inactive" | undefined) ?? "nmls_inactive" });
          return { reassigned: r.reassignments, delivered_disclosures_unchanged: r.delivered_disclosures_unchanged };
        }
        case "roster.propose": {
          need(i, "mlo_id", "state"); const on = asOf(i, ctx);
          const m = rows<MloRosterMember>(i, "roster", rt, "mlo_roster").find((x) => x.mlo_id === str(i, "mlo_id")); if (!m) throw new RangeError(`no mlo_roster member ${str(i, "mlo_id")}`);
          return proposeMloOfRecord(m, str(i, "state"), jurisdictionOf(i, rt, str(i, "state"), on), rows<License>(i, "licenses", rt, "licenses"), on);
        }
        case "eligibility": {
          need(i, "period", "quarter_end", "hfs_upb_cents", "irlc_pipeline_cents", "fallout_rate", "trailing_12m_originations_cents");
          const r = computeOrigInputs(ctx.events, { period: str(i, "period"), quarter_end: dateIn(i, "quarter_end"), hfs_upb_cents: cents(i.hfs_upb_cents), irlc_pipeline_cents: cents(i.irlc_pipeline_cents), fallout_rate: str(i, "fallout_rate"), trailing_12m_originations_cents: cents(i.trailing_12m_originations_cents), computed_at: ctx.now });
          rt.store.put("eligibility_inputs_origination", r.row.period, { ...r.row }, ctx.actor, ctx.now);
          return { row: r.row, event_id: r.event.id };
        }
        case "form582": {
          need(i, "form582_due");
          return form582SellerSideAnswers({ licenses: rows<License>(i, "licenses", rt, "licenses"), approvals: rows<FnmaApproval>(i, "approvals", rt, "fnma_approvals"), roster: rows<MloRosterMember>(i, "roster", rt, "mlo_roster"), origination_volume_cents: cents(i.origination_volume_cents), as_of: asOf(i, ctx), form582_due: dateIn(i, "form582_due") });
        }
        case "tpo_quarterly": {
          need(i, "period");
          return tpoQuarterlyPackage({ period: str(i, "period"), prefunding_defect_rate_bps: Number(i.prefunding_defect_rate_bps ?? 0), post_closing_defect_rate_bps: Number(i.post_closing_defect_rate_bps ?? 0), epd_count: Number(i.epd_count ?? 0), lqc_findings: Number(i.lqc_findings ?? 0), sla_breaches: Number(i.sla_breaches ?? 0), complaints: Number(i.complaints ?? 0), license_status_summary: (i.license_status_summary as Record<string, string> | undefined) ?? {} });
        }
        case "portal_task": case "escalate": {
          need(i, "reason");
          const kind: EscalationKind = op === "portal_task" ? "human_portal_task" : ((i.kind as EscalationKind | undefined) ?? "officer");
          return rt.escalations.open({ kind, ...(typeof i.owner_role === "string" ? { ownerRole: i.owner_role } : {}), ...(typeof i.severity === "string" ? { severity: i.severity } : {}), ...(typeof i.application_id === "string" ? { applicationId: i.application_id } : {}), payload: { reason: i.reason, package: i.package ?? null, ...(i.payload as Record<string, unknown> | undefined ?? {}) } }, ctx.actor);
        }
        case "warehouse_legal_form": {
          need(i, "to");
          const r = setWarehouseLegalForm(ctx.events, { from: (i.from as WarehouseLegalForm | undefined) ?? "secured_loan_to_partner", to: i.to as WarehouseLegalForm, by: ctx.actor, decision: (i.decision as { decision_id: string; roles: string[] } | undefined) ?? null, at: ctx.now });
          rt.store.put("feature_flags", WAREHOUSE_LEGAL_FORM_KEY, { key: WAREHOUSE_LEGAL_FORM_KEY, value: r.value, decision_id: (i.decision as { decision_id?: string } | undefined)?.decision_id ?? null }, ctx.actor, ctx.now);
          return { key: WAREHOUSE_LEGAL_FORM_KEY, value: r.value, event_id: r.event.id };
        }
        default: throw new RangeError(`licenses.upsert op ${op} is not one of license/approval/roster.reassign/roster.propose/eligibility/form582/tpo_quarterly/portal_task/escalate/warehouse_legal_form`);
      } }),
    guardrails: [NO_FILING,
      never("LICENSE_APPROVAL_NEEDS_EVIDENCE", "31.1 guardrails: may never mark a license approved without evidence (state machine: transitions only from NMLS sync or documented evidence) — T10", (i) => { const l = i.license as Partial<License> | undefined; return (i.op === undefined || i.op === "license") && !!l && typeof l === "object" && EVIDENCED_STATUSES.includes(l.status as never) && !l.evidence_document_id && !l.nmls_status_raw; }, "licenses.upsert{status=approved} needs an evidence document or an NMLS Consumer Access/B2B record"),
      never("APPROVAL_GRANT_NEEDS_EVIDENCE", "31.1 guardrails: may never mark an approval granted without evidence", (i) => { const a = i.approval as Partial<FnmaApproval> | undefined; return i.op === "approval" && !!a && typeof a === "object" && (a.status === "granted" || a.status === "active") && !a.evidence_document_id; }, "approvals.upsert{status=granted|active} needs the Fannie Mae letter/e-mail, certification confirmation or Technology Manager evidence"),
      never("SM_EMPLOYEE_NEVER_MLO_OF_RECORD", "31.1 guardrails / open question 5: may never make an SM employee assignable as mlo_of_record", (i) => i.op === "roster.propose" && i.force_assignable === true, "every mlo_of_record is partner-employed and partner-sponsored; the roster refuses employer=sm (T12)"),
      humanWhen("WAREHOUSE_LEGAL_FORM_HUMAN_ONLY", "31.1 guardrails: may never switch origination.warehouse_legal_form", (i) => i.op === "warehouse_legal_form", "the warehouse legal form is changed only by a human with an officer + attorney decision record (T9)"),
      needsRole("WAREHOUSE_LEGAL_FORM_NEEDS_OFFICER_ATTORNEY", "31.1 §G: Form B refused without an officer + attorney decision record", (i) => i.op === "warehouse_legal_form" && i.to === "purchase_at_settlement", ["officer", "attorney"], "purchase_at_settlement (table funding) is prohibited by configuration")] },
  { name: "matrix.propose", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "requirement_id", "jurisdiction", "activity", "applies_to", "requirement_kind", "citation", "quoted_text");
      const d: MatrixDraft = { requirement_id: str(i, "requirement_id"), jurisdiction: str(i, "jurisdiction"), activity: i.activity as MatrixDraft["activity"], applies_to: i.applies_to as "partner" | "sm", requirement_kind: i.requirement_kind as MatrixDraft["requirement_kind"], license_type_code: (i.license_type_code as string | undefined) ?? null, citation: str(i, "citation"), quoted_text: str(i, "quoted_text"), source_url: (i.source_url as string | undefined) ?? null, effective_from: i.effective_from ? dateIn(i, "effective_from") : asOf(i, ctx) };
      const r = proposeMatrixRow(ctx.events, d, ctx.now);
      rt.store.put("license_requirements", r.row.requirement_id, { ...r.row }, ctx.actor, ctx.now);
      return { row: r.row, event_id: r.event.id }; }),
    guardrails: [never("MATRIX_NEVER_VERIFIED_BY_AGENT", "31.1 guardrails: may never mark a matrix row verified (counsel does)", (i) => i.verification_status === "verified" || i.verification_status === "partially_verified" || i.verified === true, "matrix.propose drafts rows as unverified (fail-closed); the `verified` tool is counsel's act")] },
  { name: "license_requirements", kind: "read", handler: compute((i, ctx, rt) => {
      if (i.op === "readiness") {
        const states = Array.isArray(i.states) ? (i.states as string[]) : i.state ? [str(i, "state")] : [...new Set(rows<LicenseRequirement>(i, "license_requirements", rt, "license_requirements").map((r) => r.jurisdiction))];
        return stateReadinessReport(states.map((s) => readinessFacts(i, ctx, rt, s)));
      }
      if (i.op === "jurisdiction") { need(i, "state"); return jurisdictionOf(i, rt, str(i, "state"), asOf(i, ctx)); }
      if (typeof i.id === "string") return rt.store.get("license_requirements", i.id)?.data ?? null;
      const where = (i.where as Record<string, unknown> | undefined) ?? {};
      return rt.store.list("license_requirements", (d) => Object.entries(where).every(([k, v]) => d[k] === v)).map((r) => r.data); }) },
  { name: "verified", kind: "act", humanOnly: true, humanRoles: ["counsel", "attorney"], handler: compute((i, ctx, rt) => {
      need(i, "requirement_id", "verified_on", "memo_document_id");
      const row = (i.row as LicenseRequirement | undefined) ?? (rt.store.get("license_requirements", str(i, "requirement_id"))?.data as unknown as LicenseRequirement | undefined);
      if (!row) throw new RangeError(`no license_requirements row ${str(i, "requirement_id")}`);
      const r = verifyMatrixRow(ctx.events, row, { verified_on: dateIn(i, "verified_on"), by: ctx.actor, status: (i.status as "verified" | "partially_verified" | undefined) ?? "verified", memo_document_id: str(i, "memo_document_id"), at: ctx.now });
      rt.store.put("license_requirements", r.row.requirement_id, { ...r.row }, ctx.actor, ctx.now);
      return { row: r.row, event_id: r.event.id }; }),
    guardrails: [needsRole("COUNSEL_VERIFIES_MATRIX", "31.1 guardrails: may never mark a matrix row verified — counsel does (escalations: `attorney` — matrix verification)", () => true, ["counsel", "attorney"], "verification of a license_requirements row is counsel's act")] },
]);

/** The state gate as a command guard other processes call (20.2 solicitation, 20.3 lead, 21.1 application/MLO request, issueLE, lock): refuses through assertStateGate. */
export function assertLicenseStateGate(ctx: CommandContext, rt: ToolRuntime, i: { state: string; command: string; application_id?: string | null; lead_id?: string | null; partner_name?: string }, facts?: Partial<ReadinessFacts>): ReturnType<typeof assertStateGate> {
  const base = readinessFacts({ ...(facts as ToolInput | undefined ?? {}) }, ctx, rt, i.state);
  return assertStateGate(ctx.events, { ...i, at: ctx.now }, { ...base, ...(facts ?? {}) } as ReadinessFacts, rt.escalations);
}
