/**
 * §19.3 tools — the spec's tool strings for process 19.3, verbatim, via
 * `defineTools("19.3", "<agent>", defs)` from ../tools.ts (see section13.ts). Spread by ./section19.ts.
 *
 * Agent `security-records` (vendor/contract/AI-inventory custodian); `compliance-sentinel` runs the daily monitor
 * (`portfolio.count`) and the clocks. Guardrails encode the spec's sentences: the agent cannot activate a Tier 1 vendor,
 * send a Fannie Mae notice, or execute a cutover; it cannot mark a clause `present` without an evidence excerpt; threshold
 * status changes are logged with the count basis. The tier, the current state and the activation evidence are the vendor
 * *record's* (store-backed refusals thrown exactly as the bus throws a guardrail refusal — see 19.2), never the caller's.
 *
 * Events these tools append (the 19.3 timer rows in src/domain/data-security/timers-19-3.ts arm and close on them):
 * `contract.executed` / `contract.amended` / `contract.expiry.resolved`, `subservicing.arrangement.effective` (the executed
 * subservicing agreement), `contract_event.occurred`, `subservicing.arrangement.terminated` (a termination under it),
 * `fnma.request.received`, `fnma.data_return.directed` (a data-return demand; an SSA / TSP-schedule termination),
 * `fnma_notices.sent`, `fnma.request.responded`, `tech_provider.change.notice_sent`, `tech_provider.change.cutover`,
 * `form101.submitted` / `form101.acknowledged` / `form101.termination_submitted`, `data_return.certified`,
 * `vendor.approved` / `vendor.terminated` / `vendor.status_changed`, `vendor_assessment.completed`,
 * `vendor.incident.reported` / `vendor.incident.notice_received` / `vendor.sla_breach.logged` / `vendor.assessment.due`,
 * `portfolio_threshold_snapshot.written`, `threshold.a2101.crossed`, `integration.noncompliance.detected` /
 * `integration.interface.disabled` / `integration.compliance.restored`, `ai_system.registered` / `ai_system.changed`,
 * `ai.policy.approved` / `ai_policy.reviewed`, `form582.third_party_package.delivered`.
 */
import { defineTools, escalate, compute, never, needsRole, humanWhen, timerOps, noticeOps, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { hasRole } from "../roles.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { plainDate as D, daysBetween, type PlainDate } from "../../kernel/calendar/date.ts";
import { businessDaysBetween, fannieEt } from "../../kernel/calendar/business.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import type { TimerRegistry, TimerInstance } from "../../kernel/timers/index.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import { reassessment, type ClauseState } from "../../domain/data-security/vendors.ts";
import { thresholdSnapshot, clauseEntry, clauseChecklist, canonicalClause, vendorTransition, vendorReassessment, integrationDrift, deployGate, classifyContractEvent, fnmaRequestReceived, changeNoticeSent, assertGateOpen, form582ThirdPartyPackage, contractExpiryWarnings, form101Status, subservicingTermination, subservicingArrangementEffective, subservicingArrangementTerminated, dataReturnDirectedByTermination, ARRANGEMENT_CONTRACT_KINDS, integrationDriftDetected, integrationDriftSweep, integrationComplianceRestored, vendorIncidentReported, vendorIncidentNoticeReceived, aiPolicyApproved, aiPolicyReviewed, signatureReferencesNotice, form101AuthorizationId, type VendorStatus, type Escalation, type ContractEventKind, type ContractEventDirection, type FnmaRequestKind, type ContractorRow, type ArrangementEntity, type IntegrationInterfaceRow, type VendorIncidentRow, type AiPolicyRow } from "../../domain/data-security/ops-19-3.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const today = (ctx: CommandContext): PlainDate => D(ctx.now.slice(0, 10));
const AGENT = "security-records";
const GUARD = "19.3 guardrails: the agent cannot activate a Tier 1 vendor, send a Fannie Mae notice, or execute a cutover; it cannot mark a clause `present` without an evidence excerpt; threshold status changes are logged with the count basis";
const ACTIVATING = /^(approved|active)$/;
type Tier = 1 | 2 | 3;
const tierNumber = (v: unknown): Tier | null => { const t = Number(String(v ?? "").split("_")[0]); return t === 1 || t === 2 || t === 3 ? t : null; };
const tierLabel = (t: Tier): string => `${t}_${t === 1 ? "critical" : t === 2 ? "significant" : "low"}`;
/**
 * The vendor's tier is the record's (`vendors.tier`), set when the vendor is proposed; a caller may not re-tier an existing
 * vendor except the officer. A new vendor takes the caller's `tier` (1, 2 or 3).
 */
const resolveTier = (ctx: CommandContext, command: string, i: ToolInput, stored: unknown): Tier => {
  const rec = tierNumber(stored); const given = i.tier === undefined || i.tier === null || i.tier === "" ? null : tierNumber(i.tier);
  if (i.tier !== undefined && i.tier !== null && i.tier !== "" && given === null) throw new RangeError("tier must be 1, 2 or 3");
  if (rec !== null && given !== null && given !== rec && !hasRole(ctx.actor, ["officer"])) refuse(ctx, command, "TIER_IS_THE_RECORDS", "19.3 data model: vendors.tier; rule 2: critical providers carry Tier 1 by classification", `${str(i, "vendor_id")} is recorded as Tier ${rec}; only the officer re-tiers a vendor`);
  const t = rec !== null && (given === null || !hasRole(ctx.actor, ["officer"])) ? rec : given ?? rec;
  if (t === null) throw new RangeError("tier must be 1, 2 or 3");
  return t;
};
type ClauseInput = { clause_code?: unknown; status?: unknown; evidence_excerpt?: unknown; citation?: unknown; reviewed_by?: unknown };
const clauseInputs = (i: ToolInput): ClauseInput[] => (Array.isArray(i.clauses) ? (i.clauses as ClauseInput[]).filter((c) => c !== null && typeof c === "object") : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
/** A store-backed refusal, written and thrown exactly as the bus writes a guardrail refusal (guardrails see only the input; the vendor record lives in the store). */
const refuse = (ctx: CommandContext, command: string, code: string, citation: string, reason: string): never => {
  ctx.events.append({ type: "command.refused", loanId: ctx.loanId, actor: ctx.actor, payload: { command, code, citation, reason, subject_id: null } });
  throw new CommandRefused(command, code, citation, reason);
};
/** Open the work items a rule returned (spec escalations: officer / attorney / fnma_portal_operator → portal task). */
const openEscalations = (rt: ToolRuntime, ctx: CommandContext, list: readonly Escalation[], payload: Record<string, unknown>): { kind: string; owner_role: string; reason: string; escalation_id: string }[] =>
  list.map((e) => { const kind = e.kind === "fnma_portal_operator" ? "human_portal_task" : e.kind; const esc = rt.escalations.open({ kind, loanId: ctx.loanId, ...(e.kind === "fnma_portal_operator" ? { ownerRole: "fnma_portal_operator" } : {}), payload: { ...payload, reason: e.reason, at: e.at ?? null } }, ctx.actor); return { kind: esc.kind, owner_role: esc.ownerRole, reason: e.reason, escalation_id: esc.id }; });
/** Stored `contract_clauses` rows for a contract → clause map + whether every deviation carries the attorney's review. */
const storedClauses = (rt: ToolRuntime, contractId: string): { clauses: Record<string, ClauseState | "n_a">; attorney_signoff: boolean; deviations: string[] } => {
  const rows = contractId ? rt.store.list("contract_clauses", (d) => d.contract_id === contractId) : [];
  const clauses: Record<string, ClauseState | "n_a"> = {}; const deviations: string[] = []; let signed = true;
  for (const r of rows) { const code = String(r.data.clause_code); const st = String(r.data.status) as ClauseState | "n_a"; clauses[code] = st; if (st === "deviation") { deviations.push(code); if (!String(r.data.reviewed_by ?? "")) signed = false; } }
  return { clauses, attorney_signoff: deviations.length > 0 && signed, deviations };
};
/**
 * The officer's signature behind a recorded Fannie Mae notice: the officer records it, or the agent names the officer's
 * signature event *for this notice* — an event by a human officer, or the officer's completed work item, that references
 * the same document / contract event / request / Form 101 authorization / provider change (`signatureReferencesNotice`).
 */
const officerSignatureVerified = (i: ToolInput, ctx: CommandContext, rt: ToolRuntime): boolean => {
  if (hasRole(ctx.actor, ["officer"])) return true;
  const id = str(i, "officer_signature_event_id"); if (!id) return false;
  const ev = ctx.events.all().find((e) => e.id === id); if (!ev) return false;
  const refs = { document_id: str(i, "document_id"), contract_event_id: str(i, "contract_event_id") || null, request_id: str(i, "request_id") || null, authorization_id: str(i, "authorization_id") || null, tech_provider_change_id: str(i, "tech_provider_change_id") || null };
  if (ev.actor.kind === "human" && ev.actor.role === "officer" && signatureReferencesNotice(refs, ev.payload)) return true;
  if (ev.type === "escalation.completed") {
    const esc = rt.escalations.opened.find((x) => x.id === String(ev.payload.escalation_id) && x.kind === "officer" && x.status === "completed");
    if (esc && signatureReferencesNotice(refs, esc.payload, esc.evidenceDocumentId ?? null)) return true;
  }
  return false;
};
const integrationRow = (rt: ToolRuntime, id: string): IntegrationInterfaceRow | null => { const r = rt.store.get("integration_interfaces", id); return r ? (r.data as unknown as IntegrationInterfaceRow) : null; };

/**
 * Recurring 19.3 clocks (vendor reassessment, contract-expiry warnings, the daily threshold monitor, the annual LL-2026-04
 * policy review) are closed by the tool that performs the satisfying act and re-armed for the next cycle explicitly: the
 * kernel engine re-arms a recurring timer inside the very loop that satisfies it (src/kernel/timers/engine.ts onEvent — the
 * re-armed instance is visited in the same pass, matches the same event and re-arms again without end), so the satisfying
 * event is never appended while an armed instance of the recurring row can match it. Reported as a kernel defect in the build notes.
 */
let REGISTRY: TimerRegistry | null = null;
const registry = (): TimerRegistry => (REGISTRY ??= loadOverriddenRegistry());
const closeRecurring = (ctx: CommandContext, code: string, subject: { kind: string; id: string } | "global"): TimerInstance[] => {
  const closed: TimerInstance[] = [];
  for (const inst of ctx.timers.byCode(code)) {
    if (inst.status !== "armed" && inst.status !== "breached") continue;
    if (subject === "global" ? inst.subject.kind !== "global" : inst.subject.kind !== subject.kind || inst.subject.id !== subject.id) continue;
    inst.status = inst.status === "breached" ? "satisfied_late" : "satisfied"; inst.satisfiedAt = ctx.now; closed.push(inst);
  }
  return closed;
};
const recordSatisfied = (ctx: CommandContext, closed: readonly TimerInstance[], e: DomainEvent): void => {
  for (const inst of closed) { inst.satisfiedByEventId = e.id; ctx.events.append({ type: "timer.satisfied", loanId: ctx.loanId, actor: ctx.actor, causationId: e.id, payload: { code: inst.code, timer_id: inst.id, late: inst.status === "satisfied_late", satisfied_by: e.type } }); }
};
const rearm = (ctx: CommandContext, code: string, trigger: DomainEvent): TimerInstance | null => { const def = registry().get(code); return def ? ctx.timers.arm(def, trigger) : null; };

export const TOOLS_19_3: readonly ToolDef[] = defineTools("19.3", AGENT, [
  // ---- contracts: executed agreements ingested with clause extraction (rule 6; integrations: contract repository) ------
  { name: "contracts.extractClauses", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "contract_id", "clauses"); const contractId = str(i, "contract_id"); const escalations: Escalation[] = [];
      const rows = clauseInputs(i).map((c) => {
        const clause_code = String(c.clause_code ?? ""); if (!clause_code) throw new RangeError("clause_code is required on every clause");
        const e = clauseEntry({ clause_code, status: String(c.status ?? "missing") as ClauseState | "n_a", evidence_excerpt: c.evidence_excerpt === undefined || c.evidence_excerpt === null ? null : String(c.evidence_excerpt), reviewed_by: c.reviewed_by === undefined || c.reviewed_by === null ? null : String(c.reviewed_by) });
        if (!e.ok) throw new RangeError(e.refusal ?? "clause refused"); if (e.escalation && !c.reviewed_by) escalations.push(e.escalation);
        const prev = rt.store.get("contract_clauses", `${contractId}:${clause_code}`)?.data ?? {};
        return rt.store.put("contract_clauses", `${contractId}:${clause_code}`, { contract_id: contractId, clause_code, canonical_code: canonicalClause(clause_code), status: String(c.status ?? "missing"), citation: c.citation === undefined ? (prev.citation ?? null) : String(c.citation), evidence_excerpt: c.evidence_excerpt === undefined ? (prev.evidence_excerpt ?? null) : String(c.evidence_excerpt), reviewed_by: c.reviewed_by ? String(c.reviewed_by) : (prev.reviewed_by ?? null), reviewed_at: c.reviewed_by ? ctx.now : (prev.reviewed_at ?? null) }, ctx.actor, ctx.now).data;
      });
      ctx.events.append({ type: "contract.clauses.extracted", loanId: ctx.loanId, aggregate: { kind: "counterparty_contracts", id: contractId }, actor: ctx.actor, payload: { contract_id: contractId, clause_codes: rows.map((r) => r.clause_code), deviations: rows.filter((r) => r.status === "deviation").length, reviewed_by: hasRole(ctx.actor, ["attorney"]) ? ctx.actor.id : null } });
      // the executed agreement itself (counterparty_contracts): first ingestion arms the expiry warnings; an amendment that extends expires_at is a renewal
      let contract: Record<string, unknown> | null = null; let arrangement: Record<string, unknown> | null = null;
      if (str(i, "kind") || str(i, "expires_at") || str(i, "executed_at")) {
        const prev = rt.store.get("counterparty_contracts", contractId)?.data ?? null;
        const expires = optDate(i, "expires_at") ?? (prev?.expires_at ? D(String(prev.expires_at)) : null);
        const effective = optDate(i, "effective_from") ?? (prev?.effective_from ? D(String(prev.effective_from)) : null);
        const entity = (str(i, "entity") || String(prev?.entity ?? "") || "partner") as ArrangementEntity; if (entity !== "partner" && entity !== "supermortgage") throw new RangeError("entity must be partner or supermortgage");
        contract = rt.store.put("counterparty_contracts", contractId, { id: contractId, counterparty_id: str(i, "counterparty_id") || prev?.counterparty_id || null, vendor_id: str(i, "vendor_id") || prev?.vendor_id || null, entity, kind: str(i, "kind") || prev?.kind || "vendor_msa", executed_at: str(i, "executed_at") || prev?.executed_at || null, effective_from: effective, expires_at: expires, termination_notice_days: i.termination_notice_days ?? prev?.termination_notice_days ?? null, document_id: str(i, "document_id") || prev?.document_id || null, status: str(i, "status") || prev?.status || "executed", expiry_warnings: expires ? contractExpiryWarnings(expires) : [] }, ctx.actor, ctx.now).data;
        const payload = { contract_id: contractId, kind: contract.kind, entity, executed_at: contract.executed_at, effective_from: effective, expires_at: expires, expiry_warnings: contract.expiry_warnings };
        if (!prev) {
          ctx.events.append({ type: "contract.executed", loanId: ctx.loanId, aggregate: { kind: "counterparty_contracts", id: contractId }, actor: ctx.actor, payload });
          // A2-1-07: the executed subservicing agreement makes the arrangement effective → Form 101 must be active before any Fannie Mae application access (FNMA_A2107_FORM101_INCEPTION_GATE, T8)
          if (contract.kind === "subservicing_agreement" && effective) {
            const a = subservicingArrangementEffective({ contract_id: contractId, entity, effective_from: effective, authorization_id: str(i, "authorization_id") || null, servicer_numbers: strings(i.servicer_numbers) });
            const auth = rt.store.get("data_access_authorizations", a.authorization_id)?.data ?? {};
            rt.store.put("data_access_authorizations", a.authorization_id, { ...auth, id: a.authorization_id, master_subscriber: auth.master_subscriber ?? "partner", subordinate_subscriber: auth.subordinate_subscriber ?? "supermortgage", servicer_numbers: strings(i.servicer_numbers).length ? strings(i.servicer_numbers) : (auth.servicer_numbers ?? []), arrangement_contract_id: contractId, arrangement_effective_from: effective }, ctx.actor, ctx.now);
            ctx.events.append({ ...a.event, loanId: ctx.loanId, actor: ctx.actor });
            arrangement = { authorization_id: a.authorization_id, effective_from: effective, gate: a.gate, form101_status: form101Status({ servicer_numbers: [], fnma_ack_at: (auth.fnma_ack_at as string | null) ?? null, submitted_at: (auth.submitted_at as string | null) ?? null, executed_at: (auth.executed_at as string | null) ?? null, terminated_at: (auth.terminated_at as string | null) ?? null, termination_submitted_at: (auth.termination_submitted_at as string | null) ?? null }) };
          }
        } else {
          ctx.events.append({ type: "contract.amended", loanId: ctx.loanId, aggregate: { kind: "counterparty_contracts", id: contractId }, actor: ctx.actor, payload: { ...payload, renewed: !!(expires && prev.expires_at && expires > String(prev.expires_at)) } });
          if (expires && prev.expires_at && expires > String(prev.expires_at)) {
            const closed = closeRecurring(ctx, "SM_CONTRACT_EXPIRY_WARNING_180", { kind: "counterparty_contracts", id: contractId });
            const resolved = ctx.events.append({ type: "contract.expiry.resolved", loanId: ctx.loanId, aggregate: { kind: "counterparty_contracts", id: contractId }, actor: ctx.actor, payload: { contract_id: contractId, resolution: "renewed", expires_at: expires } });
            recordSatisfied(ctx, closed, resolved); rearm(ctx, "SM_CONTRACT_EXPIRY_WARNING_180", resolved);   // the renewed expiry starts the next −180/−90/−30 warnings
          }
        }
      }
      return { contract_id: contractId, clauses: rows, contract, arrangement, escalations: openEscalations(rt, ctx, escalations, { contract_id: contractId }) };
    }),
    guardrails: [never("CLAUSE_PRESENT_NEEDS_EVIDENCE", GUARD, (i) => clauseInputs(i).some((c) => c.status === "present" && !String(c.evidence_excerpt ?? "").trim()), "a clause is `present` only with an evidence excerpt from the executed contract"),
      needsRole("CLAUSE_REVIEW_IS_ATTORNEYS", "19.3 data model: contract_clauses.reviewed_by (attorney); escalations: clause deviations → attorney", (i) => clauseInputs(i).some((c) => !!c.reviewed_by), ["attorney"], "only the attorney records a clause review (reviewed_by)")] },
  { name: "contracts.checklist", kind: "read", handler: compute((i, ctx, rt) => {
      const contractId = str(i, "contract_id");
      const given = i.clauses as Record<string, ClauseState | "n_a"> | ClauseInput[] | undefined;
      const extra: Record<string, ClauseState | "n_a"> = Array.isArray(given) ? Object.fromEntries(clauseInputs(i).map((c) => [String(c.clause_code ?? ""), String(c.status ?? "missing") as ClauseState | "n_a"])) : (given ?? {});
      if (!contractId && Object.keys(extra).length === 0) throw new RangeError("contract_id or clauses is required");
      const stored = storedClauses(rt, contractId);
      const attorney = stored.attorney_signoff || (flag(i, "attorney_signoff") && hasRole(ctx.actor, ["attorney"]));
      const officer = flag(i, "officer_approval") && hasRole(ctx.actor, ["officer"]);
      const kind = str(i, "contract_kind") || String(rt.store.get("counterparty_contracts", contractId)?.data.kind ?? "") || null;
      return { contract_id: contractId || null, contract_kind: kind, ...clauseChecklist({ ...stored.clauses, ...extra }, { ai_provider: flag(i, "ai_provider"), contract_kind: kind, attorney_signoff: attorney, officer_approval: officer }), attorney_signoff: attorney, officer_approval: officer };
    }) },
  // ---- vendors: assessments (rule 8), incident SLA records (SM_VENDOR_INCIDENT_NOTICE_SLA) and the state machine -------
  { name: "vendors.assess", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "vendor_id"); const vendorId = str(i, "vendor_id"); const vendor = rt.store.get("vendors", vendorId); const op = str(i, "op") || "assess";
      // ---- the vendor's incident against its contractual notice SLA (data model vendor_incidents; rule 6 INCIDENT_NOTICE_24H): "incident SLA records" are assessment evidence
      if (op === "incident") {
        need(i, "security_incident_id", "vendor_aware_at");
        const slaHours = i.sla_hours === undefined || i.sla_hours === null ? (vendor?.data.incident_notice_sla_hours ? Number(vendor.data.incident_notice_sla_hours) : null) : num(i, "sla_hours");
        const r = vendorIncidentReported({ vendor_id: vendorId, security_incident_id: str(i, "security_incident_id"), vendor_aware_at: str(i, "vendor_aware_at"), reported_at: str(i, "reported_at") || ctx.now, sla_hours: slaHours });
        if (rt.store.get("vendor_incidents", r.row.id)) return { ...rt.store.get("vendor_incidents", r.row.id)!.data, idempotent: true };
        rt.store.put("vendor_incidents", r.row.id, { ...r.row }, ctx.actor, ctx.now);
        ctx.events.append({ ...r.event, loanId: ctx.loanId, actor: ctx.actor });
        return { ...r.row, timer: "SM_VENDOR_INCIDENT_NOTICE_SLA" };
      }
      if (op === "incident_notice") {   // "notice received": the vendor's written incident notice closes the SLA clock; a miss is logged and feeds a triggered reassessment
        need(i, "security_incident_id", "notice_received_at");
        const cur = rt.store.get("vendor_incidents", `${vendorId}:${str(i, "security_incident_id")}`); if (!cur) throw new RangeError(`no vendor incident ${vendorId}:${str(i, "security_incident_id")} on record`);
        const r = vendorIncidentNoticeReceived({ row: cur.data as unknown as VendorIncidentRow, notice_received_at: str(i, "notice_received_at"), document_id: str(i, "document_id") || null });
        rt.store.put("vendor_incidents", r.row.id, { ...r.row }, ctx.actor, ctx.now);
        ctx.events.append({ ...r.event, loanId: ctx.loanId, actor: ctx.actor });
        if (r.breach) ctx.events.append({ type: r.breach.type, loanId: ctx.loanId, aggregate: { kind: "vendors", id: vendorId }, actor: ctx.actor, payload: r.breach.payload });
        if (r.reassessment) { if (vendor) rt.store.put("vendors", vendorId, { ...vendor.data, next_assessment_due: r.reassessment.payload.due, sla_breaches: Number(vendor.data.sla_breaches ?? 0) + 1 }, ctx.actor, ctx.now); ctx.events.append({ type: r.reassessment.type, loanId: ctx.loanId, aggregate: { kind: "vendors", id: vendorId }, actor: ctx.actor, payload: r.reassessment.payload }); }
        return { ...r.row, breach_logged: r.breach !== null, reassessment_triggered: r.reassessment !== null };
      }
      need(i, "kind", "completed_at"); const tier = resolveTier(ctx, "vendors.assess", i, vendor?.data.tier); const completedOn = date(i, "completed_at");
      const approvedBy = str(i, "approved_by") || (hasRole(ctx.actor, ["officer"]) ? ctx.actor.id : "");
      if (tier === 1 && approvedBy && !hasRole(ctx.actor, ["officer"])) refuse(ctx, "vendors.assess", "TIER1_ASSESSMENT_APPROVED_BY_OFFICER", "19.3 data model: vendor_assessments.approved_by (officer for Tier 1)", `${vendorId} is a Tier 1 vendor: its assessment is approved by the officer; requires officer`);
      const next = reassessment(tier, completedOn);
      const id = str(i, "id") || `va-${vendorId}-${completedOn}-${str(i, "kind")}`;
      const rec = rt.store.put("vendor_assessments", id, { vendor_id: vendorId, kind: str(i, "kind"), tier, questionnaire: i.questionnaire ?? null, findings: i.findings ?? null, risk_rating: str(i, "risk_rating") || null, approved_by: approvedBy || null, completed_at: completedOn, next_assessment_due: next.due, officer_escalation_on: next.escalate_on }, ctx.actor, ctx.now);
      if (vendor) rt.store.put("vendors", vendorId, { ...vendor.data, tier: tierLabel(tier), last_assessment_id: id, last_assessment_completed_at: completedOn, next_assessment_due: next.due }, ctx.actor, ctx.now);
      const closed = closeRecurring(ctx, "FNMA_SUPP_VENDOR_REASSESSMENT", { kind: "vendors", id: vendorId });   // this assessment satisfies the running cadence clock
      const done = ctx.events.append({ type: "vendor_assessment.completed", loanId: ctx.loanId, aggregate: { kind: "vendors", id: vendorId }, actor: ctx.actor, payload: { assessment_id: id, vendor_id: vendorId, tier, kind: str(i, "kind"), completed_at: completedOn, next_assessment_due: next.due, reassessment_due: next.due, officer_escalation_on: next.escalate_on } });
      recordSatisfied(ctx, closed, done);
      const status = String(vendor?.data.status ?? "");
      if (closed.length > 0 || status === "approved" || status === "active" || status === "remediation") rearm(ctx, "FNMA_SUPP_VENDOR_REASSESSMENT", done);   // recurring: the next cycle runs from this assessment (Tier 1 365 / Tier 2 730 / Tier 3 1095)
      return { ...rec.data, reassessment_clock_closed: closed.length };
    }),
    guardrails: [needsRole("TIER1_ASSESSMENT_APPROVED_BY_OFFICER", "19.3 data model: vendor_assessments.approved_by (officer for Tier 1)", (i) => num(i, "tier") === 1 && !!str(i, "approved_by"), ["officer"], "a Tier 1 assessment is approved by the officer")] },
  { name: "vendors.setStatus", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "vendor_id", "status"); const vendorId = str(i, "vendor_id"); const to = str(i, "status") as VendorStatus;
      const cur = rt.store.get("vendors", vendorId)?.data ?? {}; const tier = resolveTier(ctx, "vendors.setStatus", i, cur.tier);
      // the current state is the record's: a caller asserting a different `from` is stale, never a shortcut through the state machine
      const from = String(cur.status ?? "proposed") as VendorStatus;
      if (str(i, "from") && str(i, "from") !== from) throw new RangeError(`stale from: vendor ${vendorId} is ${from}, not ${str(i, "from")}`);
      const officer = hasRole(ctx.actor, ["officer"]);
      if (tier === 1 && ACTIVATING.test(to) && !officer) refuse(ctx, "vendors.setStatus", "TIER1_ACTIVATION_OFFICER", GUARD, `${vendorId} is recorded as Tier 1: the agent cannot activate a Tier 1 vendor; requires officer`);
      if (tier === 1 && to === "terminated" && !officer) refuse(ctx, "vendors.setStatus", "TIER1_TERMINATION_OFFICER", "19.3 escalations: Tier 1 vendor approval/termination → officer", `${vendorId} is recorded as Tier 1: termination is the officer's decision; requires officer`);
      const aiMl = flag(i, "ai_ml_used") || cur.ai_ml_used === true; const offshore = flag(i, "offshore") || cur.offshore === true;
      // activation evidence is the record's (data model: vendors.soc2_period_end / soc2_report_document_id / bcp_evidence_document_id …); the caller's evidence is written to it, never merely asserted for one call
      const soc2PeriodEnd = optDate(i, "soc2_period_end") ?? (cur.soc2_period_end ? D(String(cur.soc2_period_end)) : null);
      const soc2Doc = str(i, "soc2_report_document_id") || String(cur.soc2_report_document_id ?? "") || null;
      const bcpDoc = str(i, "bcp_evidence_document_id") || String(cur.bcp_evidence_document_id ?? "") || (flag(i, "bcp_evidence") && officer ? `attested:${ctx.actor.id}:${ctx.now}` : null);
      const llDoc = str(i, "ll2026_04_attestation_document_id") || String(cur.ll2026_04_attestation_document_id ?? "") || (flag(i, "ll2026_04_attestation") && officer ? `attested:${ctx.actor.id}:${ctx.now}` : null);
      const aiLinked = rt.store.list("ai_systems", (d) => d.vendor_id === vendorId).length > 0 || (flag(i, "ai_systems_linked") && officer);
      const certified = ctx.events.ofType("data_return.certified").some((e) => String(e.payload.vendor_id ?? "") === vendorId) || !!cur.data_return_certified_at;
      const revokedAt = String(cur.credentials_revoked_at ?? "") || (flag(i, "credentials_revoked") && officer ? ctx.now : "");
      if (ACTIVATING.test(to) && !officer && (offshore || (aiMl && !llDoc))) refuse(ctx, "vendors.setStatus", "OFFSHORE_OR_AI_NEEDS_OFFICER", "19.3 escalations: any vendor with offshore = true or ai_ml_used = true lacking attestation → officer before activation", `${vendorId} is ${offshore ? "offshore" : "an AI/ML vendor without an LL-2026-04 attestation"}: activation is the officer's; requires officer`);
      const contractId = str(i, "contract_id") || String(cur.contract_id ?? "");
      const contract = contractId ? rt.store.get("counterparty_contracts", contractId)?.data ?? null : null;
      const stored = storedClauses(rt, contractId);   // the checklist is the stored contract_clauses rows, never a self-asserted map
      const officerNow = officer && flag(i, "officer_approval");
      const officerApproval = officerNow || !!cur.officer_approved_by;
      const asOf = optDate(i, "as_of") ?? today(ctx);
      const t = vendorTransition({ from, to, tier, ai_ml_used: aiMl, offshore, contract_kind: str(i, "contract_kind") || (contract?.kind as string | undefined) || null, onboarding_assessment_completed: !!cur.last_assessment_id, clauses: stored.clauses, attorney_signoff: stored.attorney_signoff, officer_approval: officerApproval, soc2_period_end: soc2PeriodEnd, bcp_evidence: !!bcpDoc, ai_systems_linked: aiLinked, ll2026_04_attestation: !!llDoc, data_return_certified: certified, credentials_revoked: !!revokedAt, as_of: asOf });
      const escalations = openEscalations(rt, ctx, t.escalations, { vendor_id: vendorId, from, to, contract_id: contractId || null });
      if (!t.allowed) { ctx.events.append({ type: "vendor.status_refused", loanId: ctx.loanId, aggregate: { kind: "vendors", id: vendorId }, actor: ctx.actor, payload: { vendor_id: vendorId, from, to, blockers: t.blockers } }); return { vendor_id: vendorId, from, to, allowed: false, blockers: t.blockers, escalations }; }
      // a technology-provider cutover (the replacement goes live) is the officer's act and only after the 180-day gate (T2)
      let cutover: Record<string, unknown> | null = null;
      if (str(i, "tech_provider_change_id") || str(i, "cutover_on")) {
        need(i, "tech_provider_change_id", "cutover_on"); const changeId = str(i, "tech_provider_change_id"); const change = rt.store.get("tech_provider_changes", changeId)?.data ?? null; const cutoverOn = date(i, "cutover_on");
        try { const g = assertGateOpen({ action: "tech_provider.change.cutover", notice_sent_at: change?.notice_sent_at ? D(String(change.notice_sent_at)) : null, cutover_on: cutoverOn }); cutover = { ...g, change_id: changeId, cutover_on: cutoverOn }; }
        catch (e) { const esc = (e as { escalation?: Escalation }).escalation; if (esc) rt.escalations.open({ kind: "sev1", loanId: ctx.loanId, payload: { change_id: changeId, cutover_on: cutoverOn, reason: esc.reason, gate: "FNMA_A2101_TECH_PROVIDER_CHANGE_NOTICE_180" } }, ctx.actor); ctx.events.append({ type: "tech_provider.change.cutover_refused", loanId: ctx.loanId, aggregate: { kind: "tech_provider_changes", id: changeId }, actor: ctx.actor, payload: { change_id: changeId, cutover_on: cutoverOn, reason: (e as Error).message } }); throw e; }
        rt.store.put("tech_provider_changes", changeId, { ...(change ?? { id: changeId }), status: "cutover", cutover_at: cutoverOn }, ctx.actor, ctx.now);
        ctx.events.append({ type: "tech_provider.change.cutover", loanId: ctx.loanId, aggregate: { kind: "tech_provider_changes", id: changeId }, actor: ctx.actor, payload: { change_id: changeId, cutover_on: cutoverOn, earliest_cutover_at: cutover.earliest_cutover_at, vendor_id: vendorId } });
      }
      const lastAssessed = cur.last_assessment_completed_at ? D(String(cur.last_assessment_completed_at)) : optDate(i, "assessed_on") ?? asOf;
      const reassess = reassessment(tier, lastAssessed);
      const rec = rt.store.put("vendors", vendorId, { ...cur, id: vendorId, tier: tierLabel(tier), status: to, status_changed_at: ctx.now, contract_id: contractId || null, ai_ml_used: aiMl, offshore, soc2_period_end: soc2PeriodEnd, soc2_report_document_id: soc2Doc, bcp_evidence_document_id: bcpDoc, ll2026_04_attestation_document_id: llDoc, ai_systems_linked: aiLinked, credentials_revoked_at: revokedAt || null, ...(certified && !cur.data_return_certified_at ? { data_return_certified_at: ctx.now } : {}), next_assessment_due: reassess.due, ...(officerNow ? { officer_approved_by: ctx.actor.id, officer_approved_at: ctx.now } : {}) }, ctx.actor, ctx.now);
      ctx.events.append({ type: to === "approved" ? "vendor.approved" : to === "terminated" ? "vendor.terminated" : "vendor.status_changed", loanId: ctx.loanId, aggregate: { kind: "vendors", id: vendorId }, actor: ctx.actor, payload: { vendor_id: vendorId, from, status: to, tier, contract_id: contractId || null, assessed_on: lastAssessed, reassessment_due: reassess.due, officer_escalation_on: reassess.escalate_on } });
      if (to === "offboarding" && contractId) { const closed = closeRecurring(ctx, "SM_CONTRACT_EXPIRY_WARNING_180", { kind: "counterparty_contracts", id: contractId }); recordSatisfied(ctx, closed, ctx.events.append({ type: "contract.expiry.resolved", loanId: ctx.loanId, aggregate: { kind: "counterparty_contracts", id: contractId }, actor: ctx.actor, payload: { contract_id: contractId, resolution: "offboarding", vendor_id: vendorId } })); }
      return { ...rec.data, allowed: true, blockers: [], escalations, cutover };
    }),
    guardrails: [needsRole("TIER1_ACTIVATION_OFFICER", GUARD, (i) => num(i, "tier") === 1 && ACTIVATING.test(str(i, "status")), ["officer"], "the agent cannot activate a Tier 1 vendor"),
      humanWhen("AGENT_CANNOT_EXECUTE_CUTOVER", GUARD, (i) => !!str(i, "tech_provider_change_id") || !!str(i, "cutover_on"), "the agent cannot execute a cutover — the officer runs the cutover command after assertGateOpen(FNMA_A2101_TECH_PROVIDER_CHANGE_NOTICE_180)"),
      needsRole("CUTOVER_IS_OFFICERS", "19.3 state machine: cutover blocked by assertGateOpen; escalations: every Fannie Mae notice and provider change → officer", (i) => !!str(i, "tech_provider_change_id") || !!str(i, "cutover_on"), ["officer"], "the cutover command is the officer's"),
      needsRole("TIER1_TERMINATION_OFFICER", "19.3 escalations: Tier 1 vendor approval/termination → officer", (i) => num(i, "tier") === 1 && str(i, "status") === "terminated", ["officer"], "Tier 1 vendor termination is the officer's decision"),
      needsRole("OFFSHORE_OR_AI_NEEDS_OFFICER", "19.3 escalations: any vendor with offshore = true or ai_ml_used = true lacking attestation → officer before activation", (i) => ACTIVATING.test(str(i, "status")) && (flag(i, "offshore") || (flag(i, "ai_ml_used") && !flag(i, "ll2026_04_attestation") && !str(i, "ll2026_04_attestation_document_id"))), ["officer"], "offshore or AI/ML vendors without an LL-2026-04 attestation activate only on the officer's approval")] },
  // ---- Fannie Mae notices: drafted by the agent, signed and sent by the officer, then recorded ---------------
  { name: "notices.draft", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "template_code");
      const payload: Record<string, unknown> = { ...((i.payload as Record<string, unknown> | undefined) ?? {}) };
      const noticeDate = optDate(i, "notice_date") ?? (payload.notice_date ? D(String(payload.notice_date)) : today(ctx));
      // a contract event under a technology contract: classify it (rule 5), record it, and let the event arm the 5-BD clocks
      const ev = i.contract_event as { id?: string; contract_id?: string; kind?: ContractEventKind; direction?: ContractEventDirection; occurred_on?: string; effective_on?: string; contract_kind?: string; critical_servicing_function?: boolean; document_id?: string; entity?: string; authorization_id?: string } | undefined;
      let clocks: ReturnType<typeof classifyContractEvent> | null = null; let contractEventId: string | null = null; let arrangement: Record<string, unknown> | null = null;
      if (ev?.kind && ev.direction && ev.occurred_on) {
        const contract = ev.contract_id ? rt.store.get("counterparty_contracts", ev.contract_id)?.data ?? null : null;
        const contractKind = ev.contract_kind ?? String(contract?.kind ?? "tech_provider_addendum");
        clocks = classifyContractEvent({ kind: ev.kind, direction: ev.direction, occurred_on: D(ev.occurred_on), contract_kind: contractKind, critical_servicing_function: ev.critical_servicing_function ?? null });
        contractEventId = ev.id ?? `ce-${ev.contract_id ?? "contract"}-${ev.occurred_on}-${ev.kind}`;
        if (!rt.store.get("contract_events", contractEventId)) {
          rt.store.put("contract_events", contractEventId, { id: contractEventId, contract_id: ev.contract_id ?? null, kind: ev.kind, direction: ev.direction, occurred_at: ev.occurred_on, effective_on: ev.effective_on ?? null, received_at: ctx.now, document_id: ev.document_id ?? null, fnma_notice_required: clocks.fnma_notice_required, copies_required: clocks.copies_required, event_notice_due: clocks.event_notice_due, copies_due: clocks.copies_due, basis: clocks.basis }, ctx.actor, ctx.now);
          ctx.events.append({ type: "contract_event.occurred", loanId: ctx.loanId, aggregate: { kind: "contract_events", id: contractEventId }, actor: ctx.actor, occurredAt: `${ev.occurred_on}T12:00:00.000Z`, payload: { contract_event_id: contractEventId, contract_id: ev.contract_id ?? null, kind: ev.kind, direction: ev.direction, occurred_on: ev.occurred_on, occurred_at: ev.occurred_on, effective_on: ev.effective_on ?? null, contract_kind: contractKind, critical_servicing_function: ev.critical_servicing_function ?? null, fnma_notice_required: clocks.fnma_notice_required, copies_required: clocks.copies_required, event_notice_due: clocks.event_notice_due, copies_due: clocks.copies_due, notices_required: clocks.notices_required } });
          if (ev.kind === "termination") {
            const effectiveOn = ev.effective_on ? D(ev.effective_on) : D(ev.occurred_on);
            const entity = ((ev.entity ?? contract?.entity ?? "partner") as ArrangementEntity);
            // A2-1-07 / T9: a termination under the subservicing agreement or the technology-provider addendum terminates the arrangement → Form 101 again at termination (FNMA_A2107_FORM101_TERMINATION_5BD from the effective date)
            if (ARRANGEMENT_CONTRACT_KINDS.includes(contractKind)) {
              const a = subservicingArrangementTerminated({ contract_id: ev.contract_id ?? null, contract_event_id: contractEventId, entity, occurred_on: D(ev.occurred_on), effective_on: effectiveOn, authorization_id: ev.authorization_id ?? null });
              const auth = rt.store.get("data_access_authorizations", a.authorization_id)?.data ?? {};
              rt.store.put("data_access_authorizations", a.authorization_id, { ...auth, id: a.authorization_id, master_subscriber: auth.master_subscriber ?? "partner", subordinate_subscriber: auth.subordinate_subscriber ?? "supermortgage", arrangement_terminated_effective_on: effectiveOn, form101_termination_due: a.form101_termination_due }, ctx.actor, ctx.now);
              ctx.events.append({ ...a.event, loanId: ctx.loanId, actor: ctx.actor });
              arrangement = { authorization_id: a.authorization_id, termination_effective_on: effectiveOn, form101_termination_due: a.form101_termination_due, timer: "FNMA_A2107_FORM101_TERMINATION_5BD" };
            }
            // Technology Guide: termination of Supermortgage's own SSA / TSP integration schedule directs the return or destruction of Fannie Mae Data (FNMA_TECHGUIDE_TERMINATION_RETURN_DESTROY_30D)
            const directed = dataReturnDirectedByTermination({ contract_kind: contractKind, contract_id: ev.contract_id ?? null, effective_on: effectiveOn });
            if (directed) { ctx.events.append({ ...directed, loanId: ctx.loanId, actor: ctx.actor }); arrangement = { ...(arrangement ?? {}), data_return: { source: directed.payload.source, termination_date: directed.payload.termination_date, certify_by: directed.payload.certify_by } }; }
          }
        }
        // the clocks on the rendered notice are the rule's, never the caller's
        Object.assign(payload, { occurred_on: ev.occurred_on, sent_on: payload.sent_on ?? ev.occurred_on, direction: ev.direction, copies_due: clocks.copies_due, event_notice_due: clocks.event_notice_due, due_on: clocks.copies_due ?? clocks.event_notice_due ?? payload.due_on, notices_required: clocks.notices_required, attorney_review: clocks.ambiguous });
      }
      // a Fannie Mae information request: record it, arm its clock through `fnma.request.received{kind}` and open the officer's task (T5, T10)
      let request: ReturnType<typeof fnmaRequestReceived> | null = null;
      if (str(i, "request_kind")) {
        const kind = str(i, "request_kind") as FnmaRequestKind; const receivedOn = date(i, "request_received_on"); const requestId = str(i, "request_id") || `fnma-req-${kind}-${receivedOn}`;
        request = fnmaRequestReceived({ request_id: requestId, kind, received_on: receivedOn });
        if (!rt.store.get("fnma_information_requests", requestId)) {
          rt.store.put("fnma_information_requests", requestId, { ...request.row, document_ids: Array.isArray(i.document_ids) ? i.document_ids : [] }, ctx.actor, ctx.now);
          ctx.events.append({ type: request.event.type, loanId: ctx.loanId, aggregate: { kind: "fnma_information_requests", id: requestId }, actor: ctx.actor, occurredAt: `${receivedOn}T12:00:00.000Z`, payload: request.event.payload });
          if (request.directed) ctx.events.append({ type: request.directed.type, loanId: ctx.loanId, aggregate: { kind: "fnma_information_requests", id: requestId }, actor: ctx.actor, occurredAt: `${receivedOn}T12:00:00.000Z`, payload: request.directed.payload });
        }
        Object.assign(payload, { request_on: receivedOn, request_id: requestId, due_on: request.row.due_at });
      }
      // the checklist-bearing values on the rendered notice are derived from its dates and lists, never taken from the caller
      if (payload.sent_on) payload.business_days_after = businessDaysBetween(D(String(payload.sent_on)), noticeDate, fannieEt);
      else if (payload.occurred_on) payload.business_days_after = businessDaysBetween(D(String(payload.occurred_on)), noticeDate, fannieEt);
      else if (payload.request_on) payload.business_days_after = businessDaysBetween(D(String(payload.request_on)), noticeDate, fannieEt);
      if (payload.planned_cutover) { payload.days_notice = daysBetween(noticeDate, D(String(payload.planned_cutover))); payload.earliest_cutover = changeNoticeSent({ notice_sent_at: noticeDate, planned_cutover_at: null }).earliest_cutover_at; }
      if (Array.isArray(payload.critical_functions)) payload.critical_function_count = payload.critical_functions.length;
      if (Array.isArray(payload.ai_types)) payload.ai_type_count = payload.ai_types.length;
      const inventory = rt.store.list("ai_systems"); if (inventory.length > 0) payload.inventory_count = inventory.length;   // the LL-2026-04 inventory export counts the `ai_systems` rows
      payload.notice_date = noticeDate;
      // NTC_* codes render through the Notice Registry; the DOC_/RPT_/CERT_ documents (transition plan, Form 101, Form 582 package, AI policy / system card, certification) are prepared from their document templates outside it
      let draft: unknown;
      try { draft = noticeOps("render")({ ...i, payload }, ctx, rt); }
      catch (e) { if (/^(DOC_|RPT_|CERT_)/.test(str(i, "template_code")) && e instanceof RangeError && /unknown notice template/.test(e.message)) draft = { template_code: str(i, "template_code"), kind: "document", rendered: false, payload, note: `${str(i, "template_code")} is a document template (19.3 outputs), prepared for the officer's signature outside the Notice Registry` }; else throw e; }
      // every Fannie Mae notice is signed and sent by the responsible officer
      const officer = openEscalations(rt, ctx, [request?.escalation ?? { kind: "officer", reason: `${str(i, "template_code")}: Fannie Mae notice signed and sent by the responsible officer through the channel fixed at onboarding` }, ...(clocks?.ambiguous ? [{ kind: "attorney", reason: `contract event ambiguity: confirm within the 5-BD window (by ${clocks.attorney_confirm_by}) whether the notice is a "notice of default"` } as Escalation] : [])], { template_code: str(i, "template_code"), contract_event_id: contractEventId, request_id: request?.row.id ?? null, tech_provider_change_id: str(i, "tech_provider_change_id") || null, due_on: payload.due_on ?? null });
      return { draft, clocks, contract_event_id: contractEventId, arrangement, request: request ? { ...request.row, escalation: request.escalation } : null, escalations: officer, status: "drafted", sent: false, next: "officer signs and sends through the channel fixed at onboarding; record with fnma_notices.recordSent" };
    }),
    guardrails: [never("AGENT_CANNOT_SEND_FNMA_NOTICE", GUARD, (i) => i.op === "send" || flag(i, "send"), "draft only — the responsible officer signs and sends; the agent cannot send a Fannie Mae notice"),
      never("FNMA_TEMPLATES_ONLY", "19.3 outputs: NTC_FNMA_A2101_* / NTC_FNMA_LL2026_04_DISCLOSURE / DOC_TRANSITION_PLAN / DOC_FORM101 / RPT_FORM582_THIRD_PARTIES / DOC_AI_SYSTEM_CARD / DOC_AI_GOVERNANCE_POLICY / CERT_DATA_RETURN_DESTROY", (i) => !!str(i, "template_code") && !/^(NTC_FNMA_A2101_|NTC_FNMA_LL2026_04_|DOC_TRANSITION_PLAN|DOC_FORM101|RPT_FORM582_THIRD_PARTIES|RPT_VENDOR_ASSESSMENT|DOC_AI_SYSTEM_CARD|DOC_AI_GOVERNANCE_POLICY|CERT_DATA_RETURN_DESTROY)/.test(str(i, "template_code")), "19.3 drafts only its own Fannie Mae notices and documents")] },
  { name: "fnma_notices.recordSent", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "kind", "entity", "document_id", "sent_by");
      if (!officerSignatureVerified(i, ctx, rt)) throw new RangeError("officer_signature_event_id must name the officer's signature for this notice (an event by a human officer, or the officer's completed work item, referencing the same document, contract event, request, Form 101 authorization or provider change)");
      const id = str(i, "id") || `fnma-notice-${rt.store.list("fnma_notices").length + 1}`;
      const existing = rt.store.get("fnma_notices", id); if (existing) return { ...existing.data, idempotent: true };   // notices are idempotent by fnma_notices.id
      const kind = str(i, "kind"); const requestKind = str(i, "request_kind"); const sentAt = str(i, "sent_at") || ctx.now; const sentOn = D(sentAt.slice(0, 10));
      const contractEventId = str(i, "contract_event_id"); const requestId = str(i, "request_id");
      const aggregate = contractEventId ? { kind: "contract_events", id: contractEventId } : requestId ? { kind: "fnma_information_requests", id: requestId } : { kind: "fnma_notices", id };
      const rec = rt.store.put("fnma_notices", id, { id, kind, entity: str(i, "entity"), sent_at: sentAt, sent_by: str(i, "sent_by"), channel: str(i, "channel") || "letter_and_email", document_id: str(i, "document_id"), acknowledgement_document_id: str(i, "acknowledgement_document_id") || null, timer_id: str(i, "timer_id") || null, officer_signature_event_id: str(i, "officer_signature_event_id") || (hasRole(ctx.actor, ["officer"]) ? `actor:${ctx.actor.id}` : null), copy_document_id: str(i, "copy_document_id") || null, request_id: requestId || null, contract_event_id: contractEventId || null }, ctx.actor, ctx.now);
      const at = { occurredAt: sentAt.length === 10 ? `${sentAt}T12:00:00.000Z` : sentAt };
      ctx.events.append({ type: "fnma_notices.sent", loanId: ctx.loanId, aggregate, actor: ctx.actor, ...at, payload: { id, kind, [kind]: true, entity: str(i, "entity"), document_id: str(i, "document_id"), copy_document_id: str(i, "copy_document_id") || null, sent_by: str(i, "sent_by"), sent_on: sentOn, contract_event_id: contractEventId || null, request_id: requestId || null } });
      if (requestKind || requestId) {
        const req = requestId ? rt.store.get("fnma_information_requests", requestId) : undefined; const rk = requestKind || String(req?.data.kind ?? "");
        if (req) rt.store.put("fnma_information_requests", requestId, { ...req.data, responded_at: sentAt, document_ids: [...((req.data.document_ids as string[] | undefined) ?? []), str(i, "document_id")] }, ctx.actor, ctx.now);
        ctx.events.append({ type: "fnma.request.responded", loanId: ctx.loanId, aggregate: { kind: "fnma_information_requests", id: requestId || id }, actor: ctx.actor, ...at, payload: { kind: rk, request_id: requestId || null, notice_id: id } });
      }
      if (contractEventId) { const ce = rt.store.get("contract_events", contractEventId); if (ce) rt.store.put("contract_events", contractEventId, { ...ce.data, ...(kind === "a2101_copies_5bd" ? { copies_notice_id: id } : { fnma_notice_id: id }) }, ctx.actor, ctx.now); }
      let lifecycle: Record<string, unknown> | null = null;
      switch (kind) {
        case "a2101_change_180": {   // the 180-day written notice: arms the cutover gate
          const changeId = str(i, "tech_provider_change_id") || `tpc-${str(i, "entity")}-${sentOn}`; const prev = rt.store.get("tech_provider_changes", changeId)?.data ?? {};
          const c = changeNoticeSent({ notice_sent_at: sentOn, planned_cutover_at: optDate(i, "planned_cutover_at") ?? (prev.planned_cutover_at ? D(String(prev.planned_cutover_at)) : null) });
          lifecycle = rt.store.put("tech_provider_changes", changeId, { ...prev, id: changeId, entity: str(i, "entity"), provider_from: str(i, "provider_from") || prev.provider_from || null, provider_to: str(i, "provider_to") || prev.provider_to || null, critical_functions: i.critical_functions ?? prev.critical_functions ?? [], notice_sent_at: sentOn, earliest_cutover_at: c.earliest_cutover_at, planned_cutover_at: optDate(i, "planned_cutover_at") ?? prev.planned_cutover_at ?? null, planned_cutover_blocked: c.planned_cutover_blocked, fnma_notice_id: id, status: c.status }, ctx.actor, ctx.now).data;
          ctx.events.append({ type: "tech_provider.change.notice_sent", loanId: ctx.loanId, aggregate: { kind: "tech_provider_changes", id: changeId }, actor: ctx.actor, ...at, payload: { change_id: changeId, entity: str(i, "entity"), notice_sent_at: sentOn, earliest_cutover_at: c.earliest_cutover_at, planned_cutover_at: lifecycle.planned_cutover_at, evidence_document_id: str(i, "document_id"), fnma_notice_id: id } });
          break;
        }
        case "form101": case "form101_termination": {   // Form 101 lifecycle (A2-1-07: at inception and again at termination)
          const authId = form101AuthorizationId(str(i, "entity"), str(i, "authorization_id") || null); const prev = rt.store.get("data_access_authorizations", authId)?.data ?? {};
          const ack = str(i, "acknowledgement_document_id"); const terminating = kind === "form101_termination";
          const row: Record<string, unknown> = { ...prev, id: authId, master_subscriber: str(i, "master_subscriber") || prev.master_subscriber || "partner", subordinate_subscriber: str(i, "subordinate_subscriber") || prev.subordinate_subscriber || "supermortgage", applications: i.applications ?? prev.applications ?? [], servicer_numbers: i.servicer_numbers ?? prev.servicer_numbers ?? [], executed_at: str(i, "executed_at") || prev.executed_at || sentOn, document_id: str(i, "document_id"), ...(terminating ? { termination_submitted_at: sentAt, terminated_at: str(i, "terminated_at") || prev.arrangement_terminated_effective_on || prev.terminated_at || sentOn } : { submitted_at: sentAt, fnma_ack_at: ack ? (str(i, "fnma_ack_at") || sentAt) : (prev.fnma_ack_at ?? null), ack_document_id: ack || prev.ack_document_id || null }) };
          lifecycle = { ...rt.store.put("data_access_authorizations", authId, row, ctx.actor, ctx.now).data, form101_status: form101Status({ servicer_numbers: [], fnma_ack_at: (row.fnma_ack_at as string | null) ?? null, terminated_at: (row.terminated_at as string | null) ?? null, termination_submitted_at: (row.termination_submitted_at as string | null) ?? null, submitted_at: (row.submitted_at as string | null) ?? null, executed_at: (row.executed_at as string | null) ?? null }) };
          const base = { authorization_id: authId, servicer_numbers: row.servicer_numbers, applications: row.applications, fnma_notice_id: id };
          if (terminating) {
            ctx.events.append({ type: "form101.termination_submitted", loanId: ctx.loanId, aggregate: { kind: "data_access_authorizations", id: authId }, actor: ctx.actor, ...at, payload: { ...base, terminated_at: row.terminated_at } });
            ctx.events.append({ type: "fnma.data_return.directed", loanId: ctx.loanId, aggregate: { kind: "data_access_authorizations", id: authId }, actor: ctx.actor, ...at, payload: { source: "form101_termination", termination_date: row.terminated_at, authorization_id: authId } });
            // T9 / edge case "Supermortgage's own exit": the arrangement's termination opens the 17.x transfer-out, Form 629 and data-return tasks while full service continues until cutover
            const term = subservicingTermination({ effective_on: D(String(row.terminated_at)), ...(str(i, "transfer_type") === "sub_to_sub" ? { transfer_type: "sub_to_sub" as const } : {}) });
            const tasks = term.tasks.filter((t) => t.kind !== "form101_termination").map((t) => { const kind = t.owner === "officer" ? "officer" : t.owner === "fnma_portal_operator" ? "human_portal_task" : "human_agent"; const esc = rt.escalations.open({ kind, loanId: ctx.loanId, ...(t.owner === "fnma_portal_operator" ? { ownerRole: "fnma_portal_operator" } : t.owner === "transfers" ? { ownerRole: "transfers" } : {}), payload: { task: t.kind, process: t.process, due: t.due, reason: t.reason, authorization_id: authId, termination_effective_on: row.terminated_at } }, ctx.actor); return { task: t.kind, process: t.process, due: t.due, owner_role: esc.ownerRole, escalation_id: esc.id }; });
            lifecycle = { ...lifecycle, termination: { transfer_date: term.transfer_date, form629_due: term.form629_due, data_return_cert_due: term.data_return_cert_due, tasks } };
          }
          else { ctx.events.append({ type: "form101.submitted", loanId: ctx.loanId, aggregate: { kind: "data_access_authorizations", id: authId }, actor: ctx.actor, ...at, payload: base }); if (ack) ctx.events.append({ type: "form101.acknowledged", loanId: ctx.loanId, aggregate: { kind: "data_access_authorizations", id: authId }, actor: ctx.actor, ...at, payload: { ...base, fnma_ack_at: row.fnma_ack_at, ack_document_id: ack } }); }
          break;
        }
        case "data_return_cert": {   // Technology Guide: "have a duly authorized officer … certify" — for the arrangement's Form 101, a terminated vendor, or Supermortgage's own SSA / TSP schedule
          const vendorId = str(i, "vendor_id"); const contractId = str(i, "contract_id");
          const agg = requestId ? aggregate : vendorId ? { kind: "vendors", id: vendorId } : contractId ? { kind: "counterparty_contracts", id: contractId } : { kind: "data_access_authorizations", id: form101AuthorizationId(str(i, "entity"), str(i, "authorization_id") || null) };
          if (vendorId) { const v = rt.store.get("vendors", vendorId); if (v) rt.store.put("vendors", vendorId, { ...v.data, data_return_certified_at: sentAt, data_return_certificate_document_id: str(i, "document_id") }, ctx.actor, ctx.now); }
          ctx.events.append({ type: "data_return.certified", loanId: ctx.loanId, aggregate: agg, actor: ctx.actor, ...at, payload: { certified_by: str(i, "sent_by"), certified_by_role: "officer", document_id: str(i, "document_id"), fnma_notice_id: id, vendor_id: vendorId || null, contract_id: contractId || null } });
          break;
        }
        default: break;
      }
      return { ...rec.data, lifecycle };
    }),
    guardrails: [never("FNMA_NOTICE_SENT_BY_OFFICER", GUARD, (i) => !!str(i, "kind") && !str(i, "officer_signature_event_id") && !flag(i, "recorded_by_officer"), "the agent cannot send a Fannie Mae notice — record only after the officer's signature (officer_signature_event_id names the officer's signature event for this notice; the officer may record it directly)"),
      humanWhen("FNMA_NOTICE_RECORDED_BY_OFFICER_DIRECTLY", "19.3 tools: fnma_notices.recordSent (after officer)", (i) => flag(i, "recorded_by_officer"), "recorded_by_officer is the officer's own act"),
      never("COPIES_NOTICE_NEEDS_COPY", "FNMA_A2101_CONTRACT_COPIES_5BD: satisfied by `fnma_notices.sent{a2101_copies_5bd}` with the copy attached", (i) => str(i, "kind") === "a2101_copies_5bd" && !str(i, "copy_document_id"), "attach the copy of the notice sent to the servicer")] },
  // ---- the compliance-sentinel's daily monitor (rule 1 threshold; Technology Guide 120-day integration sweep) ---------
  { name: "portfolio.count", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "entity", "as_of"); const entity = str(i, "entity"); if (entity !== "partner" && entity !== "supermortgage") throw new RangeError("entity must be partner or supermortgage");
      const asOf = date(i, "as_of");
      const given = Array.isArray(i.counts_this_year) ? (i.counts_this_year as { on: string; count: number }[]).map((c) => ({ on: D(String(c.on)), count: Number(c.count) })) : [];
      const storedRows = rt.store.list("portfolio_threshold_snapshots", (d) => d.entity === entity);
      const stored = storedRows.map((r) => ({ on: D(String(r.data.as_of)), count: Number(r.data.loan_count) }));
      const today_ = i.loan_count === undefined ? [] : [{ on: asOf, count: num(i, "loan_count") }];
      // the prior status is the latest stored snapshot of the same calendar year — the daily monitor detects a crossing on its own
      const prior = storedRows.filter((r) => String(r.data.as_of) < asOf && String(r.data.as_of).slice(0, 4) === asOf.slice(0, 4)).sort((a, b) => (String(a.data.as_of) < String(b.data.as_of) ? 1 : -1))[0];
      const previous = prior ? prior.data.a2101_regime_active === true : typeof i.previous_active === "boolean" ? i.previous_active : null;
      const snap = thresholdSnapshot({ entity, counts_this_year: [...stored, ...given, ...today_], as_of: asOf, previous_active: previous });
      rt.store.put("portfolio_threshold_snapshots", `${entity}:${asOf}`, { entity, as_of: asOf, loan_count: snap.loan_count, calendar_year: snap.calendar_year, year_max: snap.year_max, a2101_regime_active: snap.a2101_regime_active, basis: snap.basis, previous_active: previous }, ctx.actor, ctx.now);
      const closed = closeRecurring(ctx, "SM_PORTFOLIO_THRESHOLD_MONITOR_DAILY", "global");   // "snapshot written" closes today's monitor tick; tomorrow's tick arms the next
      recordSatisfied(ctx, closed, ctx.events.append({ type: "portfolio_threshold_snapshot.written", loanId: ctx.loanId, aggregate: { kind: "portfolio_threshold_snapshots", id: `${entity}:${asOf}` }, actor: ctx.actor, payload: { entity, as_of: asOf, loan_count: snap.loan_count, year_max: snap.year_max, a2101_regime_active: snap.a2101_regime_active } }));
      if (snap.changed) ctx.events.append({ type: "threshold.a2101.crossed", loanId: ctx.loanId, aggregate: { kind: "portfolio_threshold_snapshots", id: `${entity}:${asOf}` }, actor: ctx.actor, payload: { entity, a2101_regime_active: snap.a2101_regime_active, previous_active: previous, basis: snap.basis } });
      // the same daily tick sweeps the Integration Interfaces: out of compliance on day 120 → disabled (written), sev-1 (Technology Guide; T11)
      const rows = rt.store.list("integration_interfaces").map((r) => r.data as unknown as IntegrationInterfaceRow);
      const disabled = integrationDriftSweep(rows, asOf).map((d) => { rt.store.put("integration_interfaces", d.row.id, { ...d.row }, ctx.actor, ctx.now); ctx.events.append({ ...d.event, loanId: ctx.loanId, actor: ctx.actor }); openEscalations(rt, ctx, [d.escalation], { interface: d.row.id, disabled_on: d.row.disabled_on, timer: "FNMA_TECHGUIDE_INTEGRATION_COMPLIANCE_120" }); return { interface: d.row.id, disabled_on: d.row.disabled_on, day: d.event.payload.day }; });
      return { ...snap, previous_active: previous, integration_interfaces_disabled: disabled };
    }),
    guardrails: [never("THRESHOLD_CHANGE_LOGGED_WITH_BASIS", GUARD, (i) => !!str(i, "entity") && !!str(i, "as_of") && !Array.isArray(i.counts_this_year) && i.loan_count === undefined, "a threshold status is logged with its count basis — pass loan_count or counts_this_year")] },
  // ---- LL-2026-04 inventory (deploy gate) and governance policy (approval → annual review) ---------------------
  { name: "ai_systems.upsert", kind: "act", handler: compute((i, ctx, rt) => {
      // ---- the written AI/ML policy set: the designated owner (officer) approves it and reviews it at least annually (FNMA_LL2026_04_POLICY_REVIEW_365; DOC_AI_GOVERNANCE_POLICY annual review record)
      const policy = i.policy as { code?: unknown; version?: unknown; owner?: unknown; approved_on?: unknown; reviewed_on?: unknown; document_id?: unknown } | undefined;
      if (policy && typeof policy === "object") {
        const code = String(policy.code ?? ""); if (!code) throw new RangeError("policy.code is required");
        const cur = rt.store.get("ai_policy_documents", code)?.data as unknown as AiPolicyRow | undefined; const docId = policy.document_id ? String(policy.document_id) : null;
        if (policy.reviewed_on) {
          const r = aiPolicyReviewed({ row: cur ?? null, policy_code: code, reviewed_on: D(String(policy.reviewed_on)), reviewer: ctx.actor, document_id: docId });
          const closed = closeRecurring(ctx, "FNMA_LL2026_04_POLICY_REVIEW_365", { kind: "ai_policy_documents", id: code });   // the owner's review satisfies the running annual clock
          rt.store.put("ai_policy_documents", code, { ...r.row }, ctx.actor, ctx.now);
          const reviewed = ctx.events.append({ ...r.event, loanId: ctx.loanId, actor: ctx.actor });
          recordSatisfied(ctx, closed, reviewed); rearm(ctx, "FNMA_LL2026_04_POLICY_REVIEW_365", reviewed);   // recurring: the next review is due a year after this one
          return { ...r.row, late: r.late, review_clock_closed: closed.length, timer: "FNMA_LL2026_04_POLICY_REVIEW_365" };
        }
        need(policy as ToolInput, "version", "owner", "approved_on");
        const r = aiPolicyApproved({ policy_code: code, version: String(policy.version), owner: String(policy.owner), approved_on: D(String(policy.approved_on)), approved_by: ctx.actor, document_id: docId, current: cur ?? null });
        rt.store.put("ai_policy_documents", code, { ...r.row }, ctx.actor, ctx.now);
        ctx.events.append({ ...r.event, loanId: ctx.loanId, actor: ctx.actor });
        return { ...r.row, timer: "FNMA_LL2026_04_POLICY_REVIEW_365" };
      }
      need(i, "id", "name", "prompt_version", "model_version"); const id = str(i, "id");
      const cur = rt.store.get("ai_systems", id)?.data ?? null;
      const evalPass = i.eval_pass as { prompt_version?: unknown; model_version?: unknown; passed_at?: unknown } | undefined;
      const g = deployGate({ name: str(i, "name"), prompt_version: str(i, "prompt_version"), model_version: str(i, "model_version"), current: cur ? { prompt_version: String(cur.prompt_version ?? ""), model_version: String(cur.model_version ?? "") } : null, eval_pass: evalPass && typeof evalPass === "object" ? { prompt_version: String(evalPass.prompt_version ?? ""), model_version: String(evalPass.model_version ?? ""), passed_at: String(evalPass.passed_at ?? "") } : null });
      if (!g.allowed) { ctx.events.append({ type: "ai_system.deploy_blocked", loanId: ctx.loanId, aggregate: { kind: "ai_systems", id }, actor: ctx.actor, payload: { id, name: str(i, "name"), prompt_version: str(i, "prompt_version"), model_version: str(i, "model_version"), reason: g.reason } }); return { ...g, row: cur }; }
      const rec = rt.store.put("ai_systems", id, { ...(cur ?? {}), id, code: id, name: str(i, "name"), kind: str(i, "kind") || cur?.kind || "agent", purpose: str(i, "purpose") || cur?.purpose || null, vendor_id: str(i, "vendor_id") || cur?.vendor_id || null, model_version: str(i, "model_version"), prompt_version: str(i, "prompt_version"), risk_tier: str(i, "risk_tier") || cur?.risk_tier || null, consequential_decisions: i.consequential_decisions ?? cur?.consequential_decisions ?? [], human_touchpoints: i.human_touchpoints ?? cur?.human_touchpoints ?? [], eval_suite_id: str(i, "eval_suite_id") || cur?.eval_suite_id || null, last_eval_at: evalPass?.passed_at ?? cur?.last_eval_at ?? null, monitoring_dashboard: str(i, "monitoring_dashboard") || cur?.monitoring_dashboard || null, owner: str(i, "owner") || cur?.owner || null, owner_role: str(i, "owner_role") || cur?.owner_role || str(i, "owner") || cur?.owner || null, status: str(i, "status") || "active", deployed_at: ctx.now }, ctx.actor, ctx.now);
      ctx.events.append({ type: cur ? "ai_system.changed" : "ai_system.registered", loanId: ctx.loanId, aggregate: { kind: "ai_systems", id }, actor: ctx.actor, payload: { id, name: str(i, "name"), prompt_version: str(i, "prompt_version"), model_version: str(i, "model_version"), vendor_id: str(i, "vendor_id") || cur?.vendor_id || null, eval_suite_passed: true, inventory_updated: true } });
      return { ...g, row: rec.data };
    }),
    guardrails: [never("EVAL_SUITE_BEFORE_DEPLOY", "SM_AI_SYSTEM_EVAL_BEFORE_DEPLOY: eval suite pass + inventory updated before deploy — deploy blocked otherwise", (i) => flag(i, "deploy") && !i.eval_pass, "the deploy gate blocks: run the eval suite for the new prompt/model version first"),
      needsRole("AI_POLICY_IS_THE_OWNERS", "LL-2026-04: written AI/ML policies with designated owner(s) reviewing at least annually; 19.3 timer table: `ai_policy.reviewed` (owner)", (i) => !!i.policy && typeof i.policy === "object", ["officer"], "the AI/ML policy is approved and reviewed by its designated owner (officer)")] },
  // ---- timers and portal tasks ----------------------------------------------------------------------------
  { name: "timers.read", kind: "read", handler: compute((i, ctx, rt) => {
      const list = timerOps()({ ...i, op: i.op === "open" ? "open" : "list", subject_kind: str(i, "subject_kind") || "entity", subject_id: str(i, "subject_id") || str(i, "entity") || "supermortgage" }, ctx) as { id: string; code: string; status: string; due_date: PlainDate | null }[];
      const asOf = optDate(i, "as_of") ?? today(ctx);
      // the 19.3 rules that read as timer state: integration drift disables the interface on day 120 (T11); a Tier 1 reassessment overdue > 60 days is the officer's (T12)
      return list.map((t) => {
        const inst = ctx.timers.all().find((x) => x.id === t.id);
        if (!inst) return t;
        if (t.code === "FNMA_TECHGUIDE_INTEGRATION_COMPLIANCE_120") { const row = integrationRow(rt, inst.subject.id); return { ...t, interface: row, drift: integrationDrift({ detected_on: row?.detected_on ?? inst.anchorDate, restored_on: row?.restored_on ?? (inst.satisfiedAt ? D(inst.satisfiedAt.slice(0, 10)) : null), as_of: asOf }) }; }
        if (t.code === "FNMA_SUPP_VENDOR_REASSESSMENT") { const v = rt.store.get("vendors", inst.subject.id)?.data; const tier = tierNumber(v?.tier) ?? 1; const assessed = v?.last_assessment_completed_at ? D(String(v.last_assessment_completed_at)) : inst.anchorDate; return { ...t, reassessment: vendorReassessment({ tier, assessed_on: assessed, completed_on: inst.satisfiedAt ? D(inst.satisfiedAt.slice(0, 10)) : null, as_of: asOf }) }; }
        return t;
      });
    }) },
  { name: "portal_task.create", kind: "act", handler: compute((i, ctx, rt) => {
      const task = str(i, "task") || str(i, "kind_of_task") || "form_582_upload";
      // ---- Technology Guide integration compliance: drift detected → the 120-day clock and the Technology Manager task; the operator's completion evidence restores compliance (T11)
      if (task === "integration_compliance") {
        need(i, "interface"); const iface = str(i, "interface"); const cur = integrationRow(rt, iface);
        if (str(i, "op") === "complete") {
          const r = integrationComplianceRestored({ row: cur, interface: iface, restored_on: optDate(i, "restored_on") ?? today(ctx), evidence_document_id: str(i, "evidence_document_id") || null });
          rt.store.put("integration_interfaces", iface, { ...r.row }, ctx.actor, ctx.now);
          ctx.events.append({ ...r.event, loanId: ctx.loanId, actor: ctx.actor });
          const open = rt.escalations.opened.find((e) => e.kind === "human_portal_task" && e.status === "open" && e.payload.interface === iface); if (open && hasRole(ctx.actor, [open.ownerRole])) rt.escalations.complete(open.id, ctx.actor, str(i, "evidence_document_id"));
          return { interface: r.row, restored: true, late: r.late, day: r.day, timer: "FNMA_TECHGUIDE_INTEGRATION_COMPLIANCE_120" };
        }
        const r = integrationDriftDetected({ interface: iface, detected_on: optDate(i, "detected_on") ?? today(ctx), expected_spec_version: str(i, "expected_spec_version") || null, actual_spec_version: str(i, "actual_spec_version") || null, description: str(i, "description") || null, current: cur });
        if (r.already_open || !r.event || !r.task) return { interface: r.row, already_open: true, disable_on: r.disable_on };
        rt.store.put("integration_interfaces", iface, { ...r.row }, ctx.actor, ctx.now);
        ctx.events.append({ ...r.event, loanId: ctx.loanId, actor: ctx.actor });
        const opened = escalate("human_portal_task")({ ...i, kind: "human_portal_task", owner_role: r.task.owner_role, payload: { ...((i.payload as Record<string, unknown> | undefined) ?? {}), task, portal: r.task.portal, interface: iface, detected_on: r.row.detected_on, disable_on: r.disable_on, drift: r.row.drift, due: r.task.due, timer: "FNMA_TECHGUIDE_INTEGRATION_COMPLIANCE_120", reason: r.task.reason } }, ctx, rt);
        return { ...(opened as Record<string, unknown>), interface: r.row, disable_on: r.disable_on, timer: "FNMA_TECHGUIDE_INTEGRATION_COMPLIANCE_120" };
      }
      let pkg: ReturnType<typeof form582ThirdPartyPackage> | null = null;
      if (task === "form_582_upload") {   // rule 9: the third-party package handed to 18.4 with the Supplement attestation attached (T14)
        need(i, "package"); const p = i.package as Record<string, unknown>;
        if (!p || typeof p !== "object" || !p.form582_due) throw new RangeError("package.form582_due is required");
        pkg = form582ThirdPartyPackage({ form582_due: D(String(p.form582_due)), contractors: (Array.isArray(p.contractors) ? p.contractors : []) as ContractorRow[], subservicing_confirmed: p.subservicing_confirmed === true, supplement_attestation_document_id: p.supplement_attestation_document_id ? String(p.supplement_attestation_document_id) : null, ll2026_04_summary_document_id: p.ll2026_04_summary_document_id ? String(p.ll2026_04_summary_document_id) : null, delivered_on: today(ctx) });
        if (!pkg.complete) throw new RangeError(`Form 582 third-party package incomplete: ${pkg.missing.join(", ")}`);
        ctx.events.append({ type: "form582.third_party_package.delivered", loanId: ctx.loanId, actor: ctx.actor, payload: { deliver_by: pkg.deliver_by, delivered_on: today(ctx), on_time: pkg.on_time, contractors: pkg.contents.contractors.length, subservicing_confirmation: pkg.contents.subservicing_confirmation, supplement_attestation_document_id: pkg.contents.supplement_attestation_document_id, ll2026_04_program_summary_document_id: pkg.contents.ll2026_04_program_summary_document_id } });
        if (pkg.escalation) openEscalations(rt, ctx, [pkg.escalation], { task, deliver_by: pkg.deliver_by });
      }
      const attachments = Array.isArray(i.attachments) ? (i.attachments as unknown[]) : pkg ? [pkg.contents.supplement_attestation_document_id, pkg.contents.ll2026_04_program_summary_document_id] : [];
      const opened = escalate("human_portal_task")({ ...i, kind: "human_portal_task", owner_role: str(i, "owner_role") || "fnma_portal_operator", payload: { ...((i.payload as Record<string, unknown> | undefined) ?? {}), task, portal: str(i, "portal") || "technology_manager_ecrm", attachments, ...(pkg ? { package: pkg.contents, deliver_by: pkg.deliver_by, on_time: pkg.on_time } : {}), reason: i.reason ?? task } }, ctx, rt);
      return { ...(opened as Record<string, unknown>), package: pkg };
    }),
    guardrails: [never("PORTAL_TASK_NEEDS_PACKAGE", "19.3 integrations: Form 582 (ECRM in Technology Manager — portal-only) → 18.4's human_portal_task; 19.3 supplies the attachments", (i) => (str(i, "task") === "form_582_upload") && !(i.package && typeof i.package === "object") && !(Array.isArray(i.attachments) && (i.attachments as unknown[]).length > 0), "attach the Form 582 third-party package (package or attachments) before opening the upload task"),
      needsRole("INTEGRATION_RESTORED_BY_OPERATOR", "19.3 integrations: Technology Manager / TSP tasks are the fnma_portal_operator's; the operator's completion evidence restores compliance (Technology Guide §5.7)", (i) => str(i, "task") === "integration_compliance" && str(i, "op") === "complete", ["fnma_portal_operator", "officer"], "compliance is restored on the operator's completion evidence")] },
]);
