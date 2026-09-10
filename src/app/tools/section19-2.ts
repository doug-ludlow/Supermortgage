/**
 * §19.2 tools — the spec's tool strings for process 19.2, verbatim, via
 * `defineTools("19.2", "<agent>", defs)` from ../tools.ts (see section13.ts). Spread by ./section19.ts.
 *
 * Agent `security-records`. Guardrails encode the AI-agent-design sentences and bind to the log and
 * the store, never to a caller's flag:
 *   - containment tools have blast-radius limits (≤ 50 identities/hosts/secrets per action) and a rate
 *     limit (50 agent actions/hour, counted from the agent's own containment events on the log); over
 *     either limit the action is refused and a pending-approval escalation is opened for the CISO — it
 *     proceeds only once a human CISO's `ciso.approval.recorded` covers it (ops-19-2.ts recordCisoApproval)
 *     or the CISO runs it from the console; the `officer` break-glass accounts are never disabled (the
 *     registry's flag on the identity/secret record, checked against the store);
 *   - notices go only to recipients in the verified registry — the singular `recipient` and every entry
 *     of `recipients[]` must be in the store's `verified_recipients`; prompts and drafts never carry
 *     restricted FL data or full SSNs;
 *   - the agent cannot postpone `identified_at` (rule 1): the SOC's confirmation record anchors the
 *     clocks when one exists, a caller's time stands in only without one, and never later than an
 *     existing identification; an S2→S3 downgrade needs the CISO (as actor, or as an approval on the log)
 *     and a refused downgrade is on the log with a pending CISO escalation;
 *   - `exceptions.propose` never approves; `timers.read` only reads (satisfaction is event-driven);
 *   - a re-scope supersedes the incident's open scope clocks instead of arming duplicates.
 * Officer acts on the platform's portals run through `portal_task.create{submit=true}`: the officer's
 * submission records the `incident.notice.sent` (FTC / NYDFS / state AG) or `nydfs_certification.filed`
 * that closes the clock, with the receipt as evidence. `controls.runTest` runs the automated controls the
 * schedules name (CTL-SEC-01 MFA, CTL-SEC-02 credential age, CTL-SEC-03 TLS profile against the registry
 * gate, CTL-SEC-04 scan ingestion, CTL-SEC-16 restore test) and emits their program events. Every tool
 * carries `ciso` in its human roles so the IR runbook is executable from the ops console when AI is off
 * (19.2-T17). Every incident event is aggregated on the incident so the registry's satisfying events
 * close the right timers.
 */
import { defineTools, compute, read, timerOps, never, needsRole, str, num, flag, data, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { hasRole } from "../roles.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Severity } from "../../domain/data-security/incident.ts";
import { EVALUATORS_19_2 } from "../../domain/data-security/evaluators-19-2.ts";
import { triageIncident, severityFor, severityChange, identificationAnchor, currentSeverity, scopeIncident, ftcOfficerTask, containmentAction, containmentActionsLastHour, cisoApprovalFor, restrictedPromptFields, mfaControlTest, tlsControlTest, exceptionProposal, stateRegulatorRecipients, credentialReset, credentialAgeControlTest, ingestVulnerabilityScan, recordBackupRestoreTest, sendIncidentNotice, fileNydfsCertification, SecurityOpsRefused, INCIDENT_AGGREGATE, CONTAINMENT_BLAST_RADIUS, CONTAINMENT_RATE_LIMIT_PER_HOUR, type SecurityOpsContext, type AffectedPerson, type IdentityRow, type IncidentCategory, type SeverityInput, type CredentialRow, type VulnerabilityInput, type NydfsControlRow, type NoticeRecipient, type Escalation } from "../../domain/data-security/ops-19-2.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
/** A containment target list: the singular id or the plural array. */
const needTargets = (i: ToolInput, single: string, many: string): string[] => { const t = targets(i, single, many); if (t.length === 0) throw new RangeError(`${single} or ${many}[] is required`); return t; };
const AGENT = "security-records";
/** The CISO team runs the same runbook from the console when AI is off (human path). */
const HUMAN_ROLES = ["ciso", "officer", "attorney", "ops_analyst"] as const;
const SEVERITIES: readonly Severity[] = ["S1", "S2", "S3", "S4"];
const targets = (i: ToolInput, single: string, many: string): string[] => (Array.isArray(i[many]) ? (i[many] as unknown[]).map(String) : str(i, single) ? [str(i, single)] : []);
const breakGlassHints = (i: ToolInput): string[] => (Array.isArray(i.break_glass_ids) ? (i.break_glass_ids as unknown[]).map(String) : []);
const incidentAggregate = (id: string) => ({ kind: INCIDENT_AGGREGATE, id });
const opsCtx = (ctx: CommandContext): SecurityOpsContext => ({ events: ctx.events, actor: ctx.actor, now: ctx.now });
/** A store-backed refusal, written and thrown exactly as the bus writes a guardrail refusal (guardrails see only the input; the registry lives in the store). */
const refuse = (ctx: CommandContext, command: string, code: string, citation: string, reason: string): never => {
  ctx.events.append({ type: "command.refused", loanId: ctx.loanId, actor: ctx.actor, payload: { command, code, citation, reason, subject_id: null } });
  throw new CommandRefused(command, code, citation, reason);
};
/** Run a console command from ops-19-2.ts; its refusals become bus refusals with the same code. */
const viaOps = <T>(ctx: CommandContext, command: string, fn: () => T): T => { try { return fn(); } catch (e) { if (e instanceof SecurityOpsRefused) refuse(ctx, command, e.code, e.citation, e.message); throw e; } };
const openEscalation = (rt: ToolRuntime, ctx: CommandContext, e: Escalation, extra: Record<string, unknown> = {}) => rt.escalations.open({ kind: e.kind, ...(e.owner_role ? { ownerRole: e.owner_role } : {}), payload: { reason: e.reason, ...(e.within_minutes ? { within_minutes: e.within_minutes } : {}), ...(e.by_ms ? { by: new Date(e.by_ms).toISOString() } : {}), ...extra } }, ctx.actor);
/** Break-glass accounts per the identity registry (`identities.break_glass`), plus any the caller names. */
const breakGlassIds = (rt: ToolRuntime, kind: string, i: ToolInput): Set<string> => new Set([...rt.store.list(kind, (d) => d.break_glass === true).map((r) => r.id), ...breakGlassHints(i)]);
const BLAST_CITE = `19.2 guardrails: no more than ${CONTAINMENT_BLAST_RADIUS} identities/hosts per action without CISO approval`;
const RATE_CITE = `19.2 tools: containment tools are logged, reversible and rate-limited (${CONTAINMENT_RATE_LIMIT_PER_HOUR} agent actions/hour)`;
/**
 * The containment gate every containment tool runs before acting: break-glass (store), blast radius and the
 * hourly rate — the CISO's approval is the actor's role or a human CISO's `ciso.approval.recorded` on the log
 * for this incident and action; over a limit without one, the action is blocked pending CISO approval (an
 * escalation the CISO completes by recording the approval) and refused (19.2-T16).
 */
const containmentGate = (ctx: CommandContext, rt: ToolRuntime, command: string, storeKind: string, ids: readonly string[], i: ToolInput): void => {
  const bg = breakGlassIds(rt, storeKind, i); const hit = ids.find((id) => bg.has(id));
  if (hit) refuse(ctx, command, "NO_BREAK_GLASS_DISABLE", "19.2 guardrails: never disable the `officer` break-glass accounts", `${hit} is an officer break-glass account in the registry`);
  const log = ctx.events.all(); const incidentId = str(i, "incident_id") || "*"; const ciso = hasRole(ctx.actor, ["ciso"]);
  const blastApproved = ciso || i.ciso_approved === true || cisoApprovalFor(log, { kind: "containment_blast_radius", incident_id: incidentId, action: command, targets: ids.length }) !== null;
  const b = containmentAction({ targets: ids, ciso_approved: blastApproved, break_glass_ids: [...bg] });
  if (b.pending === "ciso") { openEscalation(rt, ctx, { kind: "sev2", owner_role: "ciso", reason: b.refusal! }, { pending: "ciso_approval", approval_kind: "containment_blast_radius", action: command, target_count: ids.length, incident_id: incidentId }); refuse(ctx, command, "BLAST_RADIUS_CISO", BLAST_CITE, `${b.refusal!} (19.2-T16)`); }
  if (b.refusal) refuse(ctx, command, "NO_BREAK_GLASS_DISABLE", "19.2 guardrails: never disable the `officer` break-glass accounts", b.refusal);
  if (ctx.actor.kind !== "agent") return;   // the rate limit is on the agent's tool calls; the CISO team's console actions are not metered
  const lastHour = containmentActionsLastHour(log, Date.parse(ctx.now), ctx.actor.id);
  const rateApproved = cisoApprovalFor(log, { kind: "containment_rate_limit", incident_id: incidentId, action: command }) !== null;
  const r = containmentAction({ targets: [], ciso_approved: rateApproved, actions_last_hour: lastHour });
  if (r.pending === "ciso") { openEscalation(rt, ctx, { kind: "sev2", owner_role: "ciso", reason: r.refusal! }, { pending: "ciso_approval", approval_kind: "containment_rate_limit", action: command, actions_last_hour: lastHour, incident_id: incidentId }); refuse(ctx, command, "CONTAINMENT_RATE_LIMIT", RATE_CITE, r.refusal!); }
};
const NO_BREAK_GLASS_HINT = (single: string, many: string) => never("NO_BREAK_GLASS_DISABLE", "19.2 guardrails: never disable the `officer` break-glass accounts", (i) => targets(i, single, many).some((t) => breakGlassHints(i).includes(t) || /break[-_]?glass/i.test(t)), "break-glass accounts stay enabled");
const NO_RESTRICTED_DATA = never("NO_RESTRICTED_FL_DATA_OR_SSN", "19.2 guardrails: prompts to the model provider never include restricted FL data or full SSNs (tokenized)", (i) => restrictedPromptFields({ ...data(i), prefilled: i.prefilled ?? {}, payload: i.payload ?? {} }).length > 0, "tokenize identifiers and strip restricted fair-lending fields before drafting");
const T = (d: Omit<ToolDef, "process" | "agent" | "humanRoles">): Omit<ToolDef, "process" | "agent"> => ({ ...d, humanRoles: [...HUMAN_ROLES] });
/** The officer's portal submissions the platform records (integrations: NYDFS / FTC / state AG portals are officer tasks). */
const PORTAL_SUBMISSIONS: Readonly<Record<string, { recipient: NoticeRecipient; template_code: string }>> = {
  ftc_safeguards_notification_form: { recipient: "ftc", template_code: "NTC_FTC_314_4J" },
  nydfs_cybersecurity_incident: { recipient: "nydfs", template_code: "NTC_NYDFS_500_17A" },
  nydfs_extortion_payment_24h: { recipient: "nydfs", template_code: "NTC_NYDFS_500_17C_EXTORTION_24H" },
  nydfs_extortion_explanation_30d: { recipient: "nydfs", template_code: "NTC_NYDFS_500_17C_EXTORTION_30D" },
};
const portalSubmission = (portal: string): { recipient: NoticeRecipient; template_code: string } | null => PORTAL_SUBMISSIONS[portal] ?? (/^state_ag:[A-Z]{2}$/.test(portal) ? { recipient: portal as NoticeRecipient, template_code: `NTC_BREACH_AG_${portal.slice(-2)}` } : null);
const identityRows = (rt: ToolRuntime): IdentityRow[] => rt.store.list("identities").map((x) => ({ id: x.id, kind: (x.data.kind as IdentityRow["kind"]) ?? "human", mfa_method: (x.data.mfa_method as string | null) ?? null, privileged: x.data.privileged === true, exception_approved: x.data.exception_approved === true }));
const credentialRows = (rt: ToolRuntime): CredentialRow[] => rt.store.list("identities").map((x) => ({ id: x.id, kind: (x.data.kind as CredentialRow["kind"]) ?? "human", fnma_credentials: x.data.fnma_credentials === true, last_credential_reset_at: (x.data.last_credential_reset_at as string | null) ?? null, disabled_at: (x.data.disabled_at as string | null) ?? null }));

export const TOOLS_19_2: readonly ToolDef[] = defineTools("19.2", AGENT, [
  // ---- telemetry
  T({ name: "siem.query", kind: "read", handler: read("siem_events") }),
  // ---- containment (all logged, reversible, rate-limited)
  T({ name: "idp.disableIdentity", kind: "act", handler: compute((i, ctx, rt) => { const ids = needTargets(i, "identity_id", "identity_ids"); containmentGate(ctx, rt, "idp.disableIdentity", "identities", ids, i);
      const out = ids.map((id) => rt.store.put("identities", id, { disabled_at: ctx.now, disabled_reason: str(i, "reason") || "containment", reversible: true }, ctx.actor, ctx.now).data);
      for (const id of ids) ctx.events.append({ type: "identity.disabled", actor: ctx.actor, ...(str(i, "incident_id") ? { aggregate: incidentAggregate(str(i, "incident_id")) } : {}), payload: { identity_id: id, incident_id: str(i, "incident_id") || null, auto: false, reversible: true } }); return { disabled: ids, records: out }; }),
    guardrails: [NO_BREAK_GLASS_HINT("identity_id", "identity_ids")] }),
  T({ name: "vault.rotateSecret", kind: "act", handler: compute((i, ctx, rt) => { const ids = needTargets(i, "secret_id", "secret_ids"); containmentGate(ctx, rt, "vault.rotateSecret", "secrets", ids, i);
      const out = ids.map((id) => { const prev = rt.store.get("secrets", id)?.data; const kind = str(i, "kind") || String(prev?.kind ?? "system"); const fnma = flag(i, "fnma_credentials") || prev?.fnma_credentials === true;
        const r = credentialReset(opsCtx(ctx), { secret_id: id, kind, fnma_credentials: fnma, version: Number(prev?.version ?? 0) + 1 });
        return rt.store.put("secrets", id, { rotated_at: ctx.now, version: Number(prev?.version ?? 0) + 1, kind, fnma_credentials: fnma, reset_due: r.reset_due, period_days: r.period_days, reversible: true }, ctx.actor, ctx.now).data; });
      return { rotated: ids, records: out }; }),
    guardrails: [NO_BREAK_GLASS_HINT("secret_id", "secret_ids")] }),
  T({ name: "cloud.isolateHost", kind: "act", handler: compute((i, ctx, rt) => { const ids = needTargets(i, "host_id", "host_ids"); containmentGate(ctx, rt, "cloud.isolateHost", "hosts", ids, i);
      for (const id of ids) { rt.store.put("hosts", id, { isolated_at: ctx.now, incident_id: str(i, "incident_id") || null, reversible: true }, ctx.actor, ctx.now); ctx.events.append({ type: "host.isolated", actor: ctx.actor, payload: { host_id: id, incident_id: str(i, "incident_id") || null, reversible: true } }); } return { isolated: ids }; }),
    guardrails: [NO_BREAK_GLASS_HINT("host_id", "host_ids")] }),
  T({ name: "network.blockEgress", kind: "act", handler: compute((i, ctx, rt) => { need(i, "target"); containmentGate(ctx, rt, "network.blockEgress", "hosts", [str(i, "target")], i);
      const rec = rt.store.put("egress_blocks", `${str(i, "target")}@${ctx.now}`, { target: str(i, "target"), scope: str(i, "scope") || "host", blocked_at: ctx.now, incident_id: str(i, "incident_id") || null, reversible: true }, ctx.actor, ctx.now);
      ctx.events.append({ type: "network.egress.blocked", actor: ctx.actor, payload: rec.data }); return rec.data; }) }),
  // ---- incident lifecycle
  T({ name: "incident.setSeverity", kind: "act", handler: compute((i, ctx, rt) => { need(i, "incident_id"); const id = str(i, "incident_id"); const cur = rt.store.get("security_incidents", id)?.data ?? {}; const log = ctx.events.all(); const from = (cur.severity as Severity | undefined) ?? currentSeverity(log, id);
      const facts: SeverityInput = { category: (str(i, "category") || String(cur.category ?? "other")) as IncidentCategory, confirmed_exposure: flag(i, "confirmed_exposure"), ransomware_deployed: flag(i, "ransomware_deployed"), material_ops_harm: flag(i, "material_ops_harm"), reasonable_conclusion: flag(i, "reasonable_conclusion"), data_impact: flag(i, "data_impact"), contained_event: flag(i, "contained_event") };
      const sev = (str(i, "severity") || severityFor(facts)) as Severity; if (!SEVERITIES.includes(sev)) throw new RangeError(`severity ${sev} is not one of S1–S4`);
      // escalations: an S2→S3 downgrade needs the CISO — the actor, or a human CISO's approval on the log; a refused downgrade is on the log with a pending CISO escalation
      const cisoApproved = hasRole(ctx.actor, ["ciso"]) || cisoApprovalFor(log, { kind: "severity_downgrade", incident_id: id }) !== null;
      const chg = severityChange(from, sev, cisoApproved);
      if (!chg.allowed) { openEscalation(rt, ctx, { kind: "sev2", owner_role: "ciso", reason: chg.refusal! }, { pending: "ciso_approval", approval_kind: "severity_downgrade", incident_id: id, from, to: sev }); refuse(ctx, "incident.setSeverity", "S2_TO_S3_CISO", "19.2 escalations: severity downgrade from S2 to S3 requires CISO approval", chg.refusal!); }
      // rule 1: the SOC's confirmation record anchors identification when one exists; a caller's time stands in only without one; never the tool-call time when a confirmation is given, never postponed
      const existingMs = typeof cur.identified_at === "string" ? Date.parse(cur.identified_at) : null;
      const soc = rt.store.get("soc_confirmations", id)?.data; const socMs = typeof soc?.confirmed_at === "string" ? Date.parse(soc.confirmed_at) : null;
      const at = identificationAnchor({ existing_ms: existingMs, soc_confirmed_ms: socMs, caller_confirmed_ms: str(i, "confirmed_at") ? Date.parse(str(i, "confirmed_at")) : null, now_ms: Date.parse(ctx.now) });
      if (at.refusal) refuse(ctx, "incident.setSeverity", "IDENTIFIED_AT_IMMUTABLE", "19.2 rule 1: the agent may not delay identification pending scoping", at.refusal);
      const t = triageIncident({ ...facts, severity: sev, confirmed_ms: at.identified_ms, fnma_application_data: flag(i, "fnma_application_data") || cur.fnma_application_data === true, incident_id: id });
      const identifiedAt = t.identified_at_ms === null ? ((cur.identified_at as string | undefined) ?? null) : new Date(t.identified_at_ms).toISOString();
      const rec = rt.store.put("security_incidents", id, { severity: sev, category: facts.category, identified_at: identifiedAt, identified_at_basis: str(i, "identified_at_basis") || (cur.identified_at_basis as string | undefined) || (t.event?.payload.identified_at_basis as string | undefined) || null, identified_at_source: cur.identified_at ? (cur.identified_at_source ?? at.basis) : at.basis, fnma_application_data: flag(i, "fnma_application_data") || cur.fnma_application_data === true, data_impact: facts.data_impact }, ctx.actor, ctx.now);
      if (t.event && !cur.identified_at) { ctx.events.append({ type: t.event.type, occurredAt: t.event.occurredAt, aggregate: incidentAggregate(id), actor: ctx.actor, payload: { ...t.event.payload, identified_at_source: at.basis } }); for (const e of t.escalations) openEscalation(rt, ctx, e, { incident_id: id }); }
      else if (from !== null && from !== sev) ctx.events.append({ type: "security.incident.severity_changed", aggregate: incidentAggregate(id), actor: ctx.actor, payload: { incident_id: id, from, to: sev, by: `${ctx.actor.kind}:${ctx.actor.id}`, ciso_approved: cisoApproved, changed_at: ctx.now } });
      return { ...rec.data, timers: t.timers, warnings: t.warnings, fnma_reportable: t.fnma_reportable }; }),
    guardrails: [never("IDENTIFIED_AT_IMMUTABLE", "19.2 rule 1: the agent may not delay identification pending scoping", (i) => i.identified_at !== undefined || flag(i, "postpone_identification"), "identified_at is set by the S1/S2 confirmation (the SOC record, else confirmed_at) and cannot be postponed or rewritten")] }),
  T({ name: "incident.scope", kind: "act", handler: compute((i, ctx, rt) => { need(i, "incident_id", "discovered_on"); const id = str(i, "incident_id"); const persons = (i.persons as AffectedPerson[] | undefined) ?? []; const s = scopeIncident({ discovered_on: D(str(i, "discovered_on")), persons, scoped_ms: Date.parse(ctx.now), incident_id: id });
      const prior = rt.store.get("security_incidents", id)?.data ?? {};
      if (typeof prior.discovered_at === "string" && prior.discovered_at < str(i, "discovered_on")) throw new RangeError(`discovered_at ${prior.discovered_at} is the first day the event was known and cannot move later (16 CFR 314.4(j))`);
      rt.store.put("security_incidents", id, { discovered_at: str(i, "discovered_on"), consumer_count: s.consumer_count, unencrypted_customer_info_acquired: s.unencrypted_customer_info_acquired, residents_by_state: s.residents_by_state, ny_residents: s.residents_by_state.NY ?? 0, nydfs_prong1_met: s.nydfs_prong1_met, ...(s.nydfs_prong1_met && !prior.determined_at ? { determined_at: ctx.now } : {}) }, ctx.actor, ctx.now);
      // a re-scope supersedes the incident's open scope clocks (same discovered_at anchor) instead of arming duplicates
      for (const t of ctx.timers.forSubject(INCIDENT_AGGREGATE, id)) if (t.status === "armed" && /^(FTC_314_4J_NOTIFICATION_EVENT_30D|STATE_BREACH_)/.test(t.code)) ctx.timers.cancel(t.id, "superseded by re-scope (re-armed from the same discovered_at)", ctx.actor);
      ctx.events.append({ type: s.event.type, actor: ctx.actor, aggregate: incidentAggregate(id), payload: s.event.payload });
      if (s.nydfs_prong1_met && !prior.determined_at) ctx.events.append({ type: "security.incident.determined", actor: ctx.actor, aggregate: incidentAggregate(id), payload: { incident_id: id, cybersecurity_incident: true, outcome: "cybersecurity_incident", prong: 1, determined_at: ctx.now } });
      const task = ftcOfficerTask(s, { institution_name: str(i, "institution_name") || "Supermortgage", institution_contact: str(i, "institution_contact") || "security@supermortgage.example", information_types: str(i, "information_types") || "customer information in the affected files", date_range: str(i, "date_range") || str(i, "discovered_on"), description: str(i, "description") || "unauthorized acquisition of unencrypted customer information", law_enforcement_delay: flag(i, "law_enforcement_delay"), law_enforcement_contact: str(i, "law_enforcement_contact") || null });
      for (const e of s.escalations) openEscalation(rt, ctx, e, { incident_id: id, ...(e.kind === "human_portal_task" && task ? { portal: task.portal, timer_code: task.timer_code, due: task.due, template_code: task.template_code, prefilled: task.prefilled } : {}) });
      return { ...s, event: undefined, ftc_task: task, regulator_recipients: Object.fromEntries(s.states.map((st) => [st.state, stateRegulatorRecipients(st.state)])) }; }) }),
  T({ name: "notices.draft", kind: "act", handler: compute((i, ctx, rt) => { need(i, "template_code", "incident_id");
      // guardrail: notices go only to recipients in the verified registry — the singular and every plural entry, against the store (never the caller's own `verified` flag)
      const plural = Array.isArray(i.recipients) ? (i.recipients as unknown[]).map((r) => (typeof r === "string" ? r : String((r as { email?: unknown; id?: unknown; address?: unknown }).email ?? (r as { id?: unknown }).id ?? (r as { address?: unknown }).address ?? ""))) : [];
      const addresses = [str(i, "recipient"), ...plural].filter(Boolean);
      for (const a of addresses) if (!rt.store.get("verified_recipients", a)) refuse(ctx, "notices.draft", "VERIFIED_RECIPIENTS_ONLY", "19.2 guardrails: notices go only to recipients in the verified registry", `${a} is not in the verified recipient registry`);
      const rec = rt.store.put("incident_notice_drafts", str(i, "id") || `${str(i, "incident_id")}:${str(i, "template_code")}`, { incident_id: str(i, "incident_id"), template_code: str(i, "template_code"), recipient: str(i, "recipient") || null, recipients: plural, payload: data(i), checklist: i.checklist ?? [], drafted_at: ctx.now, status: "draft_for_officer" }, ctx.actor, ctx.now);
      ctx.events.append({ type: "incident.notice.drafted", actor: ctx.actor, aggregate: incidentAggregate(str(i, "incident_id")), payload: { incident_id: rec.data.incident_id, template_code: rec.data.template_code, recipient: rec.data.recipient, recipients: plural } }); return rec.data; }),
    guardrails: [NO_RESTRICTED_DATA] }),
  T({ name: "portal_task.create", kind: "act", handler: compute((i, ctx, rt) => { need(i, "portal"); const portal = str(i, "portal");
      if (!flag(i, "submit")) return rt.escalations.open({ kind: "human_portal_task", ownerRole: str(i, "owner_role") || "officer", payload: { portal, incident_id: str(i, "incident_id") || null, prefilled: (i.prefilled as Record<string, unknown> | undefined) ?? {}, due_at: str(i, "due_at") || null, timer_code: str(i, "timer_code") || null }, ...(typeof i.case_id === "string" ? { caseId: i.case_id } : {}) }, ctx.actor);
      // the officer's submission (guardrail PORTAL_SUBMISSION_OFFICER): the portal receipt is the evidence, the send/filing event closes the clock
      need(i, "evidence_document_id"); const evidence = str(i, "evidence_document_id");
      if (portal === "nydfs_annual_certification") {
        const signers = (i.signers as { ceo_name: string; ceo_title: string; ciso_name: string; entity_name: string } | undefined) ?? { ceo_name: "", ceo_title: "", ciso_name: "", entity_name: "Supermortgage" };
        const r = viaOps(ctx, "portal_task.create", () => fileNydfsCertification(opsCtx(ctx), { controls: (i.controls as NydfsControlRow[] | undefined) ?? [], as_of: D(str(i, "as_of") || ctx.now.slice(0, 10)), signers, filed_on: D(str(i, "filed_on") || ctx.now.slice(0, 10)), filing_document_id: evidence, ...(str(i, "asserted_kind") ? { asserted_kind: str(i, "asserted_kind") as "certification" | "acknowledgment_of_noncompliance" } : {}) }));
        if (str(i, "escalation_id")) rt.escalations.complete(str(i, "escalation_id"), ctx.actor, evidence);
        return { submitted: true, portal, kind: r.package.kind, deficient_sections: r.package.deficient_sections, filing_deadline: r.package.filing_deadline, late: r.late, event_id: r.event.id };
      }
      const sub = portalSubmission(portal); if (!sub) throw new RangeError(`portal ${portal} is not one the platform records submissions for (${[...Object.keys(PORTAL_SUBMISSIONS), "state_ag:XX", "nydfs_annual_certification"].join(", ")})`);
      need(i, "incident_id");
      const r = viaOps(ctx, "portal_task.create", () => sendIncidentNotice(opsCtx(ctx), { incident_id: str(i, "incident_id"), recipient: sub.recipient, template_code: str(i, "template_code") || sub.template_code, channel: "portal", evidence_document_id: evidence, ...(str(i, "submitted_at") ? { sent_at: str(i, "submitted_at") } : {}) }));
      if (str(i, "escalation_id")) rt.escalations.complete(str(i, "escalation_id"), ctx.actor, evidence);
      return { submitted: true, portal, recipient: sub.recipient, template_code: r.row.template_code, sent_at: r.row.sent_at, event_id: r.event.id }; }),
    guardrails: [needsRole("PORTAL_SUBMISSION_OFFICER", "19.2 escalations: NYDFS/FTC/state-AG portal submissions are officer tasks (portal submissions carry certifications)", (i) => flag(i, "submit"), ["officer"], "the agent prepares; an officer submits"), NO_RESTRICTED_DATA] }),
  T({ name: "timers.read", kind: "read", handler: timerOps(), guardrails: [never("TIMERS_READ_ONLY", "19.2 tools: timers.read — satisfaction is event-driven, never a tool call", (i) => i.op !== undefined && i.op !== "list" && i.op !== "open", "timers.read only lists")] }),
  // ---- control program
  T({ name: "controls.runTest", kind: "act", handler: compute((i, ctx, rt) => { need(i, "control_code"); const code = str(i, "control_code"); const today: PlainDate = str(i, "today") ? D(str(i, "today")) : D(ctx.now.slice(0, 10)); const ops = opsCtx(ctx);
      let r: { control: string; result: "pass" | "fail" | "exception"; findings: readonly string[]; actions: readonly { action: string; target: string; by_ms: number }[]; board_report_items: readonly string[]; escalation: Escalation | null } & Record<string, unknown>;
      if (code === "CTL-SEC-01") {   // MFA coverage: a human account without MFA fails and is disabled within 15 minutes — here, in the same run (19.2-T10)
        const m = mfaControlTest((i.identities as IdentityRow[] | undefined) ?? identityRows(rt), Date.parse(ctx.now));
        for (const a of m.actions) { rt.store.put("identities", a.target, { disabled_at: ctx.now, disabled_reason: "CTL-SEC-01: no MFA (auto-disabled within 15 minutes)", auto_disabled: true, reversible: true }, ctx.actor, ctx.now); ctx.events.append({ type: "identity.disabled", aggregate: { kind: "identity", id: a.target }, actor: ctx.actor, payload: { identity_id: a.target, incident_id: null, auto: true, control: "CTL-SEC-01", by: new Date(a.by_ms).toISOString(), reason: "no MFA", reversible: true } }); }
        r = { ...m, disabled: m.actions.map((a) => a.target) };
      } else if (code === "CTL-SEC-02") {   // credential age: Fannie Mae credentials past 90 (human) / 365 (system ID) days are auto-disabled at sev-1 (19.2-T11)
        const c = credentialAgeControlTest(ops, (i.identities as CredentialRow[] | undefined) ?? credentialRows(rt), today);
        for (const d of c.disabled) rt.store.put("identities", d.identity_id, { disabled_at: ctx.now, disabled_reason: `CTL-SEC-02: credential reset overdue since ${d.due} (auto-disabled)`, auto_disabled: true, reversible: true }, ctx.actor, ctx.now);
        r = { ...c, disabled: c.disabled.map((d) => d.identity_id), next_due: c.next_due };
      } else if (code === "CTL-SEC-03") {   // TLS profile: the registry gate FNMA_TECHGUIDE_TLS_CIPHER_CUTOFF evaluated on the real cipher inventory
        const ciphers = (i.ciphers as string[] | undefined) ?? rt.store.list("tls_profiles").flatMap((p) => (p.data.ciphers as string[] | undefined) ?? []);
        const t = tlsControlTest(ciphers, today); const gate = EVALUATORS_19_2["19.2.tlsProfileEcdheGcmOnly"]!({ ciphers });
        r = { ...t, gate: "FNMA_TECHGUIDE_TLS_CIPHER_CUTOFF", gate_open: gate.open, gate_reason: gate.reason ?? null };
      } else if (code === "CTL-SEC-04") {   // weekly scan ingestion: `vulnerability.detected` per finding (arms SM_VULN_REMEDIATION_SLA), `vulnerability.remediated` per verified fix (19.2-T12)
        const v = ingestVulnerabilityScan(ops, { scan_id: str(i, "scan_id") || `${code}@${ctx.now}`, source: str(i, "source") || "scanner", findings: (i.findings as VulnerabilityInput[] | undefined) ?? [], remediated: (i.remediated as { vulnerability_id: string; remediated_at: string; verified_by_scan_id: string }[] | undefined) ?? [] });
        for (const d of v.detected) rt.store.put("vulnerabilities", d.row.id as string, d.row, ctx.actor, ctx.now);
        for (const e of v.remediated) { const vid = String(e.payload.vulnerability_id); if (rt.store.get("vulnerabilities", vid)) rt.store.put("vulnerabilities", vid, { remediated_at: e.payload.remediated_at }, ctx.actor, ctx.now); }
        const worst = v.detected.map((d) => d.breach_severity).sort()[0] ?? null;
        r = { control: code, result: v.detected.some((d) => d.breach_severity === "sev1" || d.breach_severity === "sev2") ? "fail" : "pass", findings: v.detected.map((d) => `${d.row.id}: ${d.row.severity}${d.row.internet_facing ? " internet-facing" : ""} (${d.row.cve ?? "no CVE"}) due ${d.remediation_due}`), actions: [], board_report_items: v.detected.filter((d) => d.breach_severity === "sev1").map((d) => `CTL-SEC-04: critical ${d.row.id} due ${d.remediation_due}`), escalation: worst === "sev1" ? { kind: "sev1", owner_role: "ciso", reason: "critical vulnerability detected" } : null, detected: v.detected.map((d) => ({ vulnerability_id: d.row.id, sla_due_at: d.row.sla_due_at, remediation_due: d.remediation_due, breach_severity: d.breach_severity })), remediated: v.remediated.map((e) => e.payload.vulnerability_id) };
      } else if (code === "CTL-SEC-16") {   // quarterly restore test against the tier's RTO (19.2-T13)
        need(i, "tier", "hours_to_restore");
        const b = recordBackupRestoreTest(ops, { tier: num(i, "tier") as 0 | 1 | 2, hours_to_restore: num(i, "hours_to_restore"), ran_ms: Date.parse(ctx.now), quarterly: i.quarterly === undefined ? true : flag(i, "quarterly") });
        if (b.bcp_exception) rt.store.put("control_exceptions", `${b.bcp_exception.control_code}@${ctx.now}`, { ...b.bcp_exception, status: "logged", approved_by: null, approved_at: null, expires_at: null, review_due_at: null }, ctx.actor, ctx.now);
        r = { control: b.control, result: b.result, findings: b.bcp_exception ? [b.bcp_exception.justification] : [], actions: [], board_report_items: b.bcp_exception ? [`CTL-SEC-16 fail: ${b.bcp_exception.scope} missed the ${b.rto_hours}-hour RTO`] : [], escalation: b.escalation, rto_hours: b.rto_hours, timer_code: b.timer_code, timer_disposition: b.timer_disposition, bcp_exception: b.bcp_exception, event_type: b.appended.type };
      } else throw new RangeError(`control ${code} has no automated test (CTL-SEC-01 MFA coverage, CTL-SEC-02 credential age, CTL-SEC-03 TLS profile, CTL-SEC-04 vulnerability scan ingestion, CTL-SEC-16 backup restore)`);
      const rec = rt.store.put("control_test_results", `${code}@${ctx.now}`, { control_code: code, ran_at: ctx.now, result: r.result, metrics: { findings: r.findings, actions: r.actions }, board_report_items: r.board_report_items }, ctx.actor, ctx.now);
      ctx.events.append({ type: "control_test.completed", actor: ctx.actor, aggregate: { kind: "control", id: code }, payload: { control: code, result: r.result, ran_at: ctx.now, findings: [...r.findings] } });
      if (r.escalation) openEscalation(rt, ctx, r.escalation, { control: code });
      return { ...rec.data, ...r }; }) }),
  T({ name: "exceptions.propose", kind: "act", handler: compute((i, ctx, rt) => { need(i, "control_code", "justification", "expires_on"); const p = exceptionProposal({ control_code: str(i, "control_code"), scope: str(i, "scope"), justification: str(i, "justification"), compensating_controls: str(i, "compensating_controls"), proposed_on: D(ctx.now.slice(0, 10)), expires_on: D(str(i, "expires_on")) });
      if (p.refusal) throw new RangeError(p.refusal);
      const rec = rt.store.put("control_exceptions", str(i, "id") || `${str(i, "control_code")}@${ctx.now}`, { control_code: str(i, "control_code"), scope: str(i, "scope") || null, justification: str(i, "justification"), compensating_controls: str(i, "compensating_controls") || null, status: p.status, approved_by: null, approved_at: null, expires_at: p.expires_on, review_due_at: p.review_due_on, proposed_by: `${ctx.actor.kind}:${ctx.actor.id}` }, ctx.actor, ctx.now);
      ctx.events.append({ type: "control_exception.proposed", actor: ctx.actor, aggregate: { kind: "control", id: str(i, "control_code") }, payload: { control: rec.data.control_code, expires_at: rec.data.expires_at } }); return rec.data; }),
    guardrails: [never("NO_APPROVE", "19.2 tools: exceptions.propose (no approve) — the Qualified Individual approves", (i) => flag(i, "approve") || str(i, "status") === "approved" || str(i, "approved_by") !== "", "the agent proposes; only the Qualified Individual approves")] }),
]);
