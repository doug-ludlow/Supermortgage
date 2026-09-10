/**
 * §19.2 GLBA safeguards — operating rules over the pure calculators in
 * ./incident.ts: severity assignment and triage (rule "State machine":
 * S1 confirmed exposure/ransomware/material harm; S2 reasonable conclusion or
 * BEC regardless of impact; S3 contained event, no external notice; S4
 * informational), the clocks a triage arms and the `security.incident.identified`
 * event that arms the same registry rows, the CISO-only S2→S3 downgrade, the
 * scoping step (consumer counting, FTC/state clocks from `discovered_at`, NYDFS
 * prong 1, attorney escalation for a state without a breach matrix row), the
 * officer's FTC portal task with the six 314.4(j)(2) elements, the notice-sent
 * records that satisfy the clocks, the Compliance Sentinel breach report,
 * containment blast-radius limits, the CTL-SEC-01 (MFA) and CTL-SEC-03 (TLS
 * profile) control tests, exception proposals (never approvals), the corrected
 * vulnerability SLA / credential-reset / post-incident assessment clocks, the
 * backup-restore test, the NYDFS April 15 package, and the IR runbook the human
 * IR lead executes with identical timers and templates when AI is off (19.2-T17).
 *
 * The second half of the file is the security-program lifecycle: the console commands
 * (officer sends, signatures and filings; CISO determinations, approvals and reviews),
 * the ingestion handlers (vulnerability scans, print-mail completions, restore tests) and
 * the Compliance Sentinel — every one appends, over a `SecurityOpsContext`, the event a
 * 19.2 registry row is armed by or satisfied with (see ./timers-19-2.ts). The 19.2 tools
 * (src/app/tools/section19-2.ts) call the same functions, so the agent path and the AI-off
 * console path write identical events.
 *
 * Calculators in ./incident.ts this file corrects rather than reuses (read-only
 * for this process; defects reported in the build notes):
 *   - stateNotices: CRA threshold `>=` where §899-aa(8)(b) says "more than five thousand";
 *   - credentialRotation: human Fannie Mae credentials `auto_disable: false` where rule 5
 *     and the timer row say "auto-disable on breach";
 *   - incidentClocks.assessment_complete_by: engage + 76 days instead of identified_at + 90;
 *   - vulnSlaMs: 14/30/90 days for high/medium/low instead of 30/90/180.
 */
import { type PlainDate, addDays, addMonths, daysBetween, parts, ymd } from "../../kernel/calendar/date.ts";
import type { Actor, DomainEvent, EventInput } from "../../kernel/events/index.ts";
import type { TimerDef } from "../../kernel/timers/registry.ts";
import { type Calendar, addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { wallClock, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { type Severity, incidentClocks, fnmaReportable, nydfsClocks, countConsumers, ftcNotice, tlsCipherOk, containmentAllowed, restoreTestResult, nydfsPackage, STATE_BREACH_MATRIX, type StateRule } from "./incident.ts";

const H = 3600 * 1000, MIN = 60 * 1000, ET = "America/New_York";
export const TLS_CIPHER_CUTOFF: PlainDate = "2026-10-23" as PlainDate;
export const CONTAINMENT_BLAST_RADIUS = 50;
export const CONTAINMENT_RATE_LIMIT_PER_HOUR = 50;
export const MFA_DISABLE_MINUTES = 15;
export const ATTORNEY_ESCALATION_MINUTES = 60;
export const INCIDENT_AGGREGATE = "security_incident";
const endOfDayMs = (d: PlainDate): number => zonedEpochMs(d, "23:59", ET);
const iso = (ms: number): string => new Date(ms).toISOString();

export type IncidentCategory = "ransomware" | "ddos" | "bec" | "credential_compromise" | "data_exfiltration" | "lost_media" | "vendor_incident" | "insider" | "misdirected_disclosure" | "availability" | "vulnerability_exploited" | "other";
export interface Escalation { readonly kind: "officer" | "attorney" | "sev1" | "sev2" | "sev3" | "sev4" | "human_portal_task"; readonly owner_role?: string; readonly within_minutes?: number; readonly by_ms?: number; readonly reason: string; }
export interface ArmedTimer { readonly code: string; readonly due_ms: number; }
export interface EventDraft { readonly type: string; readonly occurredAt: string; readonly aggregate: { readonly kind: string; readonly id: string }; readonly payload: Record<string, unknown>; }

// ============================================================ severity and triage
export interface SeverityInput {
  readonly category: IncidentCategory;
  /** Confirmed exposure of Confidential Information / customer information. */
  readonly confirmed_exposure: boolean;
  readonly ransomware_deployed: boolean;
  readonly material_ops_harm: boolean;
  /** The SOC's "reasonable conclusion a Cybersecurity Incident may have occurred" (Supplement). */
  readonly reasonable_conclusion: boolean;
  /** Any data impact at all (a BEC with none is still S2 — SVC-2025-01 "regardless of impact"). */
  readonly data_impact: boolean;
  /** A real, contained security event (S3) as opposed to an informational alert (S4). */
  readonly contained_event: boolean;
}
/** State machine "Severity": S1 confirmed exposure/ransomware/material harm; S2 reasonable conclusion an incident may have occurred, or BEC regardless of impact; S3 contained event with no reasonable conclusion; S4 informational. */
export function severityFor(i: SeverityInput): Severity {
  if (i.confirmed_exposure || i.ransomware_deployed || i.material_ops_harm) return "S1";
  if (i.category === "bec" || i.reasonable_conclusion) return "S2";
  return i.contained_event ? "S3" : "S4";
}

export interface TriageInput extends SeverityInput {
  /** When the SOC confirmed the alert (ms epoch). Rule 1: this sets `identified_at` for S1/S2 — the agent may not delay it pending scoping. */
  readonly confirmed_ms: number;
  readonly fnma_application_data: boolean;
  /** The CISO's confirmed severity, when it overrides the facts-derived one (escalations: an S2→S3 downgrade needs the CISO — see severityChange). */
  readonly severity?: Severity;
  readonly incident_id?: string;
  readonly cal?: Calendar;
}
export interface Triage {
  readonly severity: Severity;
  readonly identified_at_ms: number | null;
  readonly fnma_reportable: boolean;
  readonly external_notice_allowed: boolean;
  readonly timers: readonly ArmedTimer[];
  /** 50 / 75 / 90 % of the 36-hour Fannie Mae clock (breach column: officer + CISO page). */
  readonly warnings: readonly { readonly pct: 50 | 75 | 90; readonly at_ms: number }[];
  readonly escalations: readonly Escalation[];
  /** The `security.incident.identified` event that arms the registry rows — occurring at `identified_at`, never at the tool call. */
  readonly event: EventDraft | null;
}
/** Rule 1 + timer table: an S1/S2 confirmation is the identification; it arms the partner 24 h, Fannie Mae Supplement 36 h (and Form 101 36 h where application Data is involved), NYDFS determination 48 h, lost-media 36 h and, for S1, the post-incident assessment. S3/S4 arm nothing and never notify externally. */
export function triageIncident(i: TriageInput): Triage {
  const severity = i.severity ?? severityFor(i);
  if (!fnmaReportable(severity)) return { severity, identified_at_ms: null, fnma_reportable: false, external_notice_allowed: false, timers: [], warnings: [], escalations: severity === "S3" ? [{ kind: "sev3", owner_role: "ciso", reason: "S3 contained event: logged, no external notice, weekly CISO review" }] : [], event: null };
  const c = incidentClocks(i.confirmed_ms, i.cal ?? servicer);
  const timers: ArmedTimer[] = [
    { code: "SM_PARTNER_INCIDENT_NOTICE_24H", due_ms: c.partner_due_ms },
    { code: "FNMA_SUPP_INCIDENT_NOTICE_36H", due_ms: c.fnma_due_ms },
    { code: "SM_NYDFS_DETERMINATION_48H", due_ms: nydfsClocks(i.confirmed_ms, null).determination_due_ms },
  ];
  if (i.fnma_application_data) timers.push({ code: "FNMA_FORM101_DATA_INCIDENT_NOTICE_36H", due_ms: i.confirmed_ms + 36 * H });
  if (i.category === "lost_media") timers.push({ code: "FNMA_SUPP_LOST_MEDIA_NOTICE_36H", due_ms: i.confirmed_ms + 36 * H });
  const escalations: Escalation[] = [{ kind: "officer", reason: "every partner and Fannie Mae incident notice is sent by an officer from the agent's draft" }];
  if (severity === "S1") { const a = postIncidentAssessmentClocks(i.confirmed_ms, i.cal ?? servicer); timers.push({ code: "FNMA_SUPP_POST_INCIDENT_ASSESSMENT", due_ms: a.complete_by_ms }); escalations.push({ kind: "sev1", owner_role: "ciso", reason: "S1: confirmed exposure, ransomware or material harm" }); }
  const identifiedAt = iso(i.confirmed_ms);
  return { severity, identified_at_ms: i.confirmed_ms, fnma_reportable: true, external_notice_allowed: true, timers: sortTimers(timers), warnings: ([50, 75, 90] as const).map((pct, k) => ({ pct, at_ms: c.warnings_ms[k]! })), escalations,
    event: { type: "security.incident.identified", occurredAt: identifiedAt, aggregate: { kind: INCIDENT_AGGREGATE, id: i.incident_id ?? "" }, payload: { incident_id: i.incident_id ?? null, severity, category: i.category, fnma_application_data: i.fnma_application_data, identified_at: identifiedAt, identified_at_basis: i.confirmed_exposure ? "confirmed_identification" : "reasonable_conclusion", data_impact: i.data_impact } } };
}
const sortTimers = (t: readonly ArmedTimer[]): ArmedTimer[] => [...t].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

/** Escalations: a severity downgrade from S2 to S3 requires CISO approval; raising severity never does. Identification is never postponed by a change. */
export function severityChange(from: Severity | null, to: Severity, cisoApproved: boolean): { allowed: boolean; refusal: string | null; requires: "ciso" | null } {
  if (from === "S2" && to === "S3" && !cisoApproved) return { allowed: false, refusal: "severity downgrade from S2 to S3 requires CISO approval (19.2 escalations)", requires: "ciso" };
  return { allowed: true, refusal: null, requires: from === "S2" && to === "S3" ? "ciso" : null };
}

/** Rule 1: `identified_at` is the earlier of an existing identification and this confirmation — a later SOC record never moves it, and a confirmation in the future is refused. */
export function identifiedAtFor(existingMs: number | null, confirmedMs: number, nowMs: number): { identified_ms: number; refusal: string | null } {
  if (Number.isNaN(confirmedMs)) return { identified_ms: nowMs, refusal: "confirmed_at must be an ISO instant" };
  if (confirmedMs > nowMs) return { identified_ms: nowMs, refusal: "confirmed_at cannot be in the future; identification is the SOC's confirmation, never postponed" };
  if (existingMs !== null && confirmedMs > existingMs) return { identified_ms: existingMs, refusal: null };
  return { identified_ms: confirmedMs, refusal: null };
}

// ============================================================ scoping
export interface AffectedPerson { readonly id: string; readonly state: string; readonly encrypted: boolean; readonly key_compromised_or_presumed: boolean; }
export interface ScopeInput { readonly discovered_on: PlainDate; readonly persons: readonly AffectedPerson[]; readonly matrix?: Readonly<Record<string, StateRule>>; readonly scoped_ms?: number; readonly incident_id?: string; }
export interface StateClock { readonly state: string; readonly residents: number; readonly consumer_due: PlainDate; readonly ag_due: PlainDate | null; readonly cra_due: PlainDate | null; readonly timers: readonly { code: string; due: PlainDate }[]; }
export interface Scope {
  readonly consumer_count: number;
  readonly unencrypted_customer_info_acquired: "yes" | "presumed" | "no";
  readonly residents_by_state: Readonly<Record<string, number>>;
  readonly ftc: { required: boolean; due: PlainDate | null; internal_target: PlainDate | null; timer: ArmedTimer | null };
  readonly states: readonly StateClock[];
  readonly refused_states: readonly string[];
  readonly nydfs_prong1_met: boolean;
  readonly escalations: readonly Escalation[];
  /** `security.incident.scoped` with the registry's anchor field `discovered_at` (FTC/NY clocks) and the consumer-notice due the regulator/CRA rows travel with. */
  readonly event: EventDraft;
}
/** State breach clocks from `jurisdiction_rules.breach_notice`: consumer notice, AG at/above its threshold, CRAs only when residents exceed the CRA threshold ("more than five thousand New York residents" — §899-aa(8)(b)); a missing row refuses the clock and escalates to `attorney` within 1 hour. */
export function stateBreachClocks(state: string, discoveredOn: PlainDate, residents: number, matrix: Readonly<Record<string, StateRule>> = STATE_BREACH_MATRIX): { consumer_due: PlainDate; ag_due: PlainDate | null; cra_due: PlainDate | null } | { refused: true; escalate: "attorney"; within_minutes: 60 } {
  const r = matrix[state];
  if (!r) return { refused: true, escalate: "attorney", within_minutes: 60 };
  return { consumer_due: addDays(discoveredOn, r.consumer_days), ag_due: r.ag_days !== null && residents >= r.ag_threshold ? addDays(discoveredOn, r.ag_days) : null, cra_due: r.cra_threshold !== null && residents > r.cra_threshold ? addDays(discoveredOn, r.consumer_days) : null };
}
/** Rules 1–2: distinct individuals whose unencrypted (or key-compromised/presumed) information was acquired; FTC ≥ 500 from `discovered_at` (the anchor never moves when the count is corrected later); state clocks from the matrix; NYDFS prong (1) is met the moment any FTC or state-regulator notice becomes required. */
export function scopeIncident(i: ScopeInput): Scope {
  const cc = countConsumers(i.persons);
  const acquired: Scope["unencrypted_customer_info_acquired"] = cc.unencrypted_or_key_presumed === 0 ? "no" : i.persons.some((p) => !p.encrypted) ? "yes" : "presumed";
  const f = ftcNotice(i.discovered_on, cc.unencrypted_or_key_presumed);
  const ftcTimer = f.required && f.due ? { code: "FTC_314_4J_NOTIFICATION_EVENT_30D", due_ms: endOfDayMs(f.due) } : null;
  const states: StateClock[] = []; const refused: string[] = []; const escalations: Escalation[] = [];
  for (const [state, residents] of Object.entries(cc.by_state).sort()) {
    const r = stateBreachClocks(state, i.discovered_on, residents, i.matrix ?? STATE_BREACH_MATRIX);
    if ("refused" in r) { refused.push(state); escalations.push({ kind: "attorney", within_minutes: r.within_minutes, ...(i.scoped_ms !== undefined ? { by_ms: i.scoped_ms + ATTORNEY_ESCALATION_MINUTES * MIN } : {}), reason: `no jurisdiction_rules.breach_notice row for ${state}: clock computation refused (19.2 jurisdiction overrides)` }); continue; }
    const timers: { code: string; due: PlainDate }[] = [{ code: state === "NY" ? "STATE_BREACH_CONSUMER_NOTICE_NY_30D" : `STATE_BREACH_CONSUMER_NOTICE_${state}`, due: r.consumer_due }];
    if (r.ag_due) timers.push({ code: state === "NY" ? "STATE_BREACH_REGULATOR_NOTICE_NY" : `STATE_BREACH_AG_NOTICE_${state}`, due: r.ag_due });
    if (r.cra_due) timers.push({ code: state === "NY" ? "STATE_BREACH_CRA_NOTICE_NY_5000" : `STATE_BREACH_CRA_NOTICE_${state}`, due: r.cra_due });
    states.push({ state, residents, consumer_due: r.consumer_due, ag_due: r.ag_due, cra_due: r.cra_due, timers });
  }
  const prong1 = f.required || states.some((s) => s.ag_due !== null);
  if (f.required) escalations.push({ kind: "human_portal_task", owner_role: "officer", reason: "FTC Safeguards notification form: officer task with the six 314.4(j) content elements prefilled" });
  const ny = states.find((s) => s.state === "NY");
  const scopedAt = iso(i.scoped_ms ?? endOfDayMs(i.discovered_on));
  return { consumer_count: cc.unencrypted_or_key_presumed, unencrypted_customer_info_acquired: acquired, residents_by_state: cc.by_state, ftc: { ...f, timer: ftcTimer }, states, refused_states: refused, nydfs_prong1_met: prong1, escalations,
    event: { type: "security.incident.scoped", occurredAt: scopedAt, aggregate: { kind: INCIDENT_AGGREGATE, id: i.incident_id ?? "" }, payload: { incident_id: i.incident_id ?? null, consumer_count: cc.unencrypted_or_key_presumed, unencrypted_customer_info_acquired: acquired, residents_by_state: cc.by_state, ny_residents: cc.by_state.NY ?? 0, discovered_at: i.discovered_on, discovered_on: i.discovered_on, scoped_at: scopedAt, consumer_notice_due: ny?.consumer_due ?? null, nydfs_prong1_met: prong1 } } };
}

/** NY GBL §899-aa: the regulator notices that travel with/before the consumer notices — AG, Department of State, State Police, and DFS for a Part 500 covered entity. */
export function stateRegulatorRecipients(state: string): readonly string[] {
  return state === "NY" ? ["state_ag:NY", "state_other:NY_DOS", "state_other:NY_STATE_POLICE", "nydfs"] : [`state_ag:${state}`];
}

/** FTC 314.4(j)(2): the `officer` portal task with the six content elements prefilled from the scope; null when the notification event involves fewer than 500 consumers. */
export interface FtcTaskDetails { readonly institution_name: string; readonly institution_contact: string; readonly information_types: string; readonly date_range: string; readonly description: string; readonly law_enforcement_delay: boolean; readonly law_enforcement_contact?: string | null; }
export interface FtcOfficerTask { readonly kind: "human_portal_task"; readonly owner_role: "officer"; readonly portal: "ftc_safeguards_notification_form"; readonly timer_code: "FTC_314_4J_NOTIFICATION_EVENT_30D"; readonly due: PlainDate; readonly internal_target: PlainDate; readonly template_code: "NTC_FTC_314_4J"; readonly prefilled: Readonly<Record<string, unknown>>; }
export function ftcOfficerTask(scope: Scope, d: FtcTaskDetails): FtcOfficerTask | null {
  if (!scope.ftc.required || !scope.ftc.due || !scope.ftc.internal_target) return null;
  return { kind: "human_portal_task", owner_role: "officer", portal: "ftc_safeguards_notification_form", timer_code: "FTC_314_4J_NOTIFICATION_EVENT_30D", due: scope.ftc.due, internal_target: scope.ftc.internal_target, template_code: "NTC_FTC_314_4J",
    prefilled: { element_1_name_contact: `${d.institution_name}, ${d.institution_contact}`, element_2_information_types: d.information_types, element_3_date_range: d.date_range, element_4_consumer_count: scope.consumer_count, element_5_description: d.description, element_6_law_enforcement: d.law_enforcement_delay ? `written determination that notifying the public would impede a criminal investigation (${d.law_enforcement_contact ?? "contact on file"})` : "no law enforcement official has provided a written determination that notifying the public would impede a criminal investigation" } };
}

// ============================================================ notices sent (the satisfying events)
export type NoticeRecipient = "partner" | "fannie_mae_supplement" | "fannie_mae_form101" | "nydfs" | "ftc" | "consumers" | "cras" | "law_enforcement" | "mi_companies" | "custodian" | "cyber_insurer" | "board" | `state_ag:${string}` | `state_other:${string}`;
export interface NoticeSentInput { readonly incident_id: string; readonly recipient: NoticeRecipient; readonly template_code: string; readonly sent_ms: number; readonly sent_by_role: string; readonly channel: string; readonly evidence_document_id?: string | null; readonly kind?: string; }
/** `incident_notices` row + `incident.notice.sent{recipient}` — the officer's send that satisfies the notice timers (every regulatory or partner notice is an `officer` act). */
export function incidentNoticeSent(i: NoticeSentInput): { row: Record<string, unknown>; event: EventDraft; refusal: string | null } {
  const refusal = i.sent_by_role === "officer" ? null : `19.2 escalations: every regulatory or partner notice is sent by an officer, not ${i.sent_by_role}`;
  const row = { incident_id: i.incident_id, recipient: i.recipient, template_code: i.template_code, sent_at: iso(i.sent_ms), sent_by: i.sent_by_role, channel: i.channel, evidence_document_id: i.evidence_document_id ?? null, ...(i.kind ? { kind: i.kind } : {}) };
  return { row, refusal, event: { type: "incident.notice.sent", occurredAt: iso(i.sent_ms), aggregate: { kind: INCIDENT_AGGREGATE, id: i.incident_id }, payload: { ...row } } };
}
/** NY GBL §899-aa(8)(a): the composite `incident.state_regulator_notices.sent{state}` only once the AG, Department of State, State Police and DFS have all been notified. */
export function stateRegulatorNoticesComplete(state: string, incidentId: string, sent: readonly { recipient: string; sent_ms: number }[]): { complete: boolean; missing: readonly string[]; event: EventDraft | null } {
  const required = stateRegulatorRecipients(state);
  const missing = required.filter((r) => !sent.some((s) => s.recipient === r));
  if (missing.length) return { complete: false, missing, event: null };
  const last = Math.max(...sent.filter((s) => required.includes(s.recipient)).map((s) => s.sent_ms));
  return { complete: true, missing: [], event: { type: "incident.state_regulator_notices.sent", occurredAt: iso(last), aggregate: { kind: INCIDENT_AGGREGATE, id: incidentId }, payload: { incident_id: incidentId, state, recipients: required, sent_at: iso(last) } } };
}
/** `consumer_notices.mailed` for all residents of a state (STATE_BREACH_CONSUMER_NOTICE_<XX>): mailed only when every affected resident has a mailed or substitute notice. */
export function consumerNoticesMailed(state: string, incidentId: string, residents: number, mailed: number, substitute: number, mailedMs: number): { all_residents: boolean; outstanding: number; event: EventDraft | null } {
  const outstanding = Math.max(0, residents - mailed - substitute);
  if (outstanding > 0) return { all_residents: false, outstanding, event: null };
  return { all_residents: true, outstanding: 0, event: { type: "consumer_notices.mailed", occurredAt: iso(mailedMs), aggregate: { kind: INCIDENT_AGGREGATE, id: incidentId }, payload: { incident_id: incidentId, state, residents, mailed, substitute, all_residents: true } } };
}

/** Compliance Sentinel: every timer that breached — including those satisfied late, which stay in the report even though the notice was sent (19.2-T2). */
export interface SentinelRow { readonly code: string; readonly status: string; readonly due_at: string | null; readonly satisfied_at: string | null; readonly late_by_minutes: number | null; }
export function sentinelReport(instances: readonly { code: string; status: string; dueAt?: number; satisfiedAt?: string; breachedAt?: string }[]): { breaches: readonly SentinelRow[] } {
  const breaches = instances.filter((t) => t.status === "breached" || t.status === "satisfied_late").map((t) => ({ code: t.code, status: t.status, due_at: t.dueAt !== undefined ? iso(t.dueAt) : null, satisfied_at: t.satisfiedAt ?? null, late_by_minutes: t.dueAt !== undefined && t.satisfiedAt ? Math.round((Date.parse(t.satisfiedAt) - t.dueAt) / MIN) : null }));
  return { breaches };
}

// ============================================================ containment guardrails
export interface ContainmentInput { readonly targets: readonly string[]; readonly ciso_approved: boolean; readonly break_glass_ids?: readonly string[]; readonly actions_last_hour?: number; }
/** Guardrails: no more than 50 identities/hosts per action without CISO approval; rate-limited (50 actions/hour); never disable the `officer` break-glass accounts (the registry's flagged identities, not the caller's say-so). */
export function containmentAction(i: ContainmentInput): { allowed: boolean; refusal: string | null; pending: "ciso" | null; reversible: true } {
  const bg = new Set(i.break_glass_ids ?? []);
  const hit = i.targets.find((t) => bg.has(t) || /break[-_]?glass/i.test(t));
  if (hit) return { allowed: false, refusal: `never disable the officer break-glass account ${hit}`, pending: null, reversible: true };
  if (!containmentAllowed(i.targets.length, i.ciso_approved)) return { allowed: false, refusal: `${i.targets.length} targets exceed the blast-radius limit of ${CONTAINMENT_BLAST_RADIUS}; blocked pending CISO approval`, pending: "ciso", reversible: true };
  if ((i.actions_last_hour ?? 0) >= CONTAINMENT_RATE_LIMIT_PER_HOUR && !i.ciso_approved) return { allowed: false, refusal: `${i.actions_last_hour} containment actions in the last hour reach the rate limit of ${CONTAINMENT_RATE_LIMIT_PER_HOUR}; blocked pending CISO approval`, pending: "ciso", reversible: true };
  return { allowed: true, refusal: null, pending: null, reversible: true };
}
/** Guardrail: prompts to the model provider (and the drafts built from them) never include restricted FL data or full SSNs — a deep scan for the restricted keys (19.4 classes, GLBA identifiers) and SSN-shaped values. */
export const RESTRICTED_PROMPT_FIELDS: readonly string[] = ["ssn", "tin", "dob", "account_number", "race", "ethnicity", "sex", "race_codes", "ethnicity_codes", "age_at_application", "fl_restricted", "restricted_fl"];
export function restrictedPromptFields(payload: unknown, path = ""): readonly string[] {
  if (payload === null || typeof payload !== "object") return typeof payload === "string" && /\b\d{3}-\d{2}-\d{4}\b/.test(payload) ? [`${path || "$"}: full SSN`] : [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (RESTRICTED_PROMPT_FIELDS.includes(k.toLowerCase())) out.push(p);
    out.push(...restrictedPromptFields(v, p));
  }
  return out;
}

// ============================================================ control tests
export interface IdentityRow { readonly id: string; readonly kind: "human" | "system" | "fnma_system_id" | "vendor"; readonly mfa_method: string | null; readonly privileged?: boolean; readonly exception_approved?: boolean; }
export interface ControlResult { readonly control: string; readonly result: "pass" | "fail" | "exception"; readonly findings: readonly string[]; readonly actions: readonly { action: string; target: string; by_ms: number }[]; readonly board_report_items: readonly string[]; readonly escalation: Escalation | null; }
/** CTL-SEC-01 (314.4(c)(5); 500.12): every human identity has MFA (FIDO2 for privileged). One human account without MFA → `fail`, disabled within 15 minutes, in the next board report unless an approved exception exists. */
export function mfaControlTest(identities: readonly IdentityRow[], ranMs: number): ControlResult {
  const humans = identities.filter((x) => x.kind === "human");
  const noMfa = humans.filter((x) => !x.mfa_method);
  const unexcepted = noMfa.filter((x) => !x.exception_approved);
  const weakPriv = humans.filter((x) => x.privileged && x.mfa_method && x.mfa_method !== "fido2");
  const findings = [...noMfa.map((x) => `${x.id}: no MFA`), ...weakPriv.map((x) => `${x.id}: privileged without FIDO2 (${x.mfa_method})`)];
  const result: ControlResult["result"] = findings.length === 0 ? "pass" : unexcepted.length === 0 && weakPriv.length === 0 ? "exception" : "fail";
  return { control: "CTL-SEC-01", result, findings, actions: unexcepted.map((x) => ({ action: "idp.disableIdentity", target: x.id, by_ms: ranMs + MFA_DISABLE_MINUTES * MIN })), board_report_items: unexcepted.map((x) => `CTL-SEC-01 fail: ${x.id} without MFA`), escalation: result === "fail" ? { kind: "sev2", owner_role: "ciso", reason: "CTL-SEC-01 MFA coverage failed" } : null };
}
/** CTL-SEC-03 (Technology Guide TLS profile): only ECDHE-GCM ciphers; a non-conforming cipher still enabled on or before the cutoff fails sev-1 before Oct. 23, 2026 (19.2-T15). */
export function tlsControlTest(ciphers: readonly string[], today: PlainDate): ControlResult & { readonly cutoff: PlainDate; readonly before_cutoff: boolean } {
  const bad = ciphers.filter((c) => !tlsCipherOk(c));
  const beforeCutoff = today < TLS_CIPHER_CUTOFF;
  const result: ControlResult["result"] = bad.length === 0 && ciphers.length > 0 ? "pass" : "fail";
  return { control: "CTL-SEC-03", result, findings: bad.map((c) => `${c}: not an ECDHE-GCM cipher`), actions: bad.map((c) => ({ action: "tls.disableCipher", target: c, by_ms: zonedEpochMs(TLS_CIPHER_CUTOFF, "00:00", ET) })), board_report_items: bad.length ? [`CTL-SEC-03 fail: ${bad.length} legacy cipher(s) still enabled`] : [], escalation: result === "fail" ? { kind: "sev1", owner_role: "ciso", reason: `TLS profile allows ${bad.join(", ")} ${beforeCutoff ? "before" : "after"} the ${TLS_CIPHER_CUTOFF} cutoff` } : null, cutoff: TLS_CIPHER_CUTOFF, before_cutoff: beforeCutoff };
}
/** Exceptions are proposed by the agent and approved only by the Qualified Individual, with expiry ≤ 12 months. */
export function exceptionProposal(i: { control_code: string; scope: string; justification: string; compensating_controls: string; proposed_on: PlainDate; expires_on: PlainDate; approve?: boolean }): { status: "proposed"; refusal: string | null; review_due_on: PlainDate; expires_on: PlainDate } {
  const maxExpiry = addDays(i.proposed_on, 366);
  if (i.approve) return { status: "proposed", refusal: "the agent proposes exceptions; only the Qualified Individual approves (tools: exceptions.propose — no approve)", review_due_on: i.expires_on, expires_on: i.expires_on };
  if (i.expires_on > maxExpiry) return { status: "proposed", refusal: `exception expiry ${i.expires_on} exceeds 12 months from ${i.proposed_on} (rule 6)`, review_due_on: maxExpiry, expires_on: maxExpiry };
  return { status: "proposed", refusal: null, review_due_on: addDays(i.proposed_on, 365) < i.expires_on ? addDays(i.proposed_on, 365) : i.expires_on, expires_on: i.expires_on };
}

/** NYDFS 500.16(d) / rule 9: the quarterly automated restore test against the tier's RTO (Tier 0 ≤ 4 h, Tier 1 ≤ 8 h, Tier 2 ≤ 24 h). A miss is a `failed` test: the annual timer is not satisfied, a sev-1 is raised and the BCP exception is logged (19.2-T13). */
export interface RestoreTestInput { readonly tier: 0 | 1 | 2; readonly hours_to_restore: number; readonly ran_ms: number; readonly quarterly?: boolean; }
export interface RestoreTest { readonly control: "CTL-SEC-16"; readonly result: "pass" | "fail"; readonly rto_hours: number; readonly timer_code: "NYDFS_500_16D_BACKUP_RESTORE_TEST_365"; readonly timer_disposition: "satisfied" | "failed"; readonly escalation: Escalation | null; readonly bcp_exception: { readonly control_code: "CTL-SEC-16"; readonly scope: string; readonly justification: string; readonly logged_at: string } | null; readonly event: EventDraft; }
export function backupRestoreTest(i: RestoreTestInput): RestoreTest {
  const rto = i.tier === 0 ? 4 : i.tier === 1 ? 8 : 24;
  const passed = restoreTestResult(i.tier, i.hours_to_restore) === "passed";
  const at = iso(i.ran_ms);
  return { control: "CTL-SEC-16", result: passed ? "pass" : "fail", rto_hours: rto, timer_code: "NYDFS_500_16D_BACKUP_RESTORE_TEST_365", timer_disposition: passed ? "satisfied" : "failed",
    escalation: passed ? null : { kind: "sev1", owner_role: "ciso", reason: `Tier ${i.tier} restore took ${i.hours_to_restore} h against an RTO of ${rto} h (NYDFS 500.16(d); BCP-01)` },
    bcp_exception: passed ? null : { control_code: "CTL-SEC-16", scope: `Tier ${i.tier} backup restore`, justification: `restore test ${at} missed the ${rto}-hour RTO (${i.hours_to_restore} h)`, logged_at: at },
    event: { type: passed ? "backup_restore_test.passed" : "backup_restore_test.failed", occurredAt: at, aggregate: { kind: "control", id: "CTL-SEC-16" }, payload: { control: "CTL-SEC-16", tier: i.tier, hours_to_restore: i.hours_to_restore, rto_hours: rto, passed, quarterly: i.quarterly ?? true, ran_at: at } } };
}

/** Rule 11 / 500.17(b): the April 15 package — a certification only when no control failed without an approved exception at the reporting date; otherwise an acknowledgment of noncompliance listing the deficient Part 500 sections (19.2-T14). */
export const CONTROL_NYDFS_SECTIONS: Readonly<Record<string, string>> = { "CTL-SEC-01": "500.12 (multi-factor authentication)", "CTL-SEC-02": "500.7 (access privileges)", "CTL-SEC-03": "500.15 (encryption of nonpublic information)", "CTL-SEC-04": "500.5 (vulnerability management)", "CTL-SEC-05": "500.6 (audit trail)", "CTL-SEC-06": "500.13 (asset inventory)", "CTL-SEC-07": "500.14 (monitoring and training)", "CTL-SEC-16": "500.16 (incident response and business continuity)" };
export interface NydfsControlRow { readonly id: string; readonly result: "pass" | "fail"; readonly exception_approved: boolean; readonly nydfs_section?: string; }
export interface NydfsAnnualPackage { readonly kind: "certification" | "acknowledgment_of_noncompliance"; readonly deficient_controls: readonly string[]; readonly deficient_sections: readonly string[]; readonly filing_deadline: PlainDate; readonly days_before_apr15: number; readonly payload: Record<string, unknown>; }
export function nydfsAnnualPackage(controls: readonly NydfsControlRow[], asOf: PlainDate, signers: { ceo_name: string; ceo_title: string; ciso_name: string; entity_name: string }): NydfsAnnualPackage {
  const p = nydfsPackage(controls.map((c) => ({ id: c.id, result: c.result, exception_approved: c.exception_approved })));
  const sections = p.deficient.map((id) => `${controls.find((c) => c.id === id)?.nydfs_section ?? CONTROL_NYDFS_SECTIONS[id] ?? "500.2 (cybersecurity program)"} — ${id} failed without an approved exception as of ${asOf}`);
  const { y } = parts(asOf);
  const apr15 = ymd(y, 4, 15) >= asOf ? ymd(y, 4, 15) : ymd(y + 1, 4, 15);
  const year = parts(apr15).y - 1;
  const certification = p.kind === "certification";
  return { kind: p.kind, deficient_controls: p.deficient, deficient_sections: sections, filing_deadline: apr15, days_before_apr15: daysBetween(asOf, apr15),
    payload: { notice_date: asOf, entity_name: signers.entity_name, year, certification, deficient_sections: sections, deficient_count: sections.length, deficiency_detail: certification ? "" : `${sections.length} control test(s) failed on ${asOf} without an approved exception`, remediation_plan: certification ? "" : "remediation owners assigned; Qualified Individual review within 30 days; re-test before the next quarterly certification", ceo_name: signers.ceo_name, ceo_title: signers.ceo_title, ciso_name: signers.ciso_name, signed_on: asOf, filing_year: parts(apr15).y, days_before_apr15: daysBetween(asOf, apr15), sent_by_role: "officer" } };
}

// ============================================================ corrected clocks
/** Timer table `SM_VULN_REMEDIATION_SLA`: critical internet-facing 72 h; critical 7 d; high 30 d; medium 90 d; low 180 d (policy). (./incident.ts vulnSlaMs uses 14/30/90 d for high/medium/low — see notes.) */
export function vulnRemediationDueMs(detectedMs: number, severity: "critical" | "high" | "medium" | "low", internetFacing: boolean): number {
  const hours = severity === "critical" ? (internetFacing ? 72 : 7 * 24) : severity === "high" ? 30 * 24 : severity === "medium" ? 90 * 24 : 180 * 24;
  return detectedMs + hours * H;
}
/** Weekly scan ingestion: the `vulnerability.detected` event with the computed anchor `remediation_due` the registry row is anchored on (offset 0) and `sla_due_at` for the `vulnerabilities` row; "sev by severity" on breach. */
export interface VulnerabilityInput { readonly vulnerability_id: string; readonly asset_id: string; readonly cve: string | null; readonly severity: "critical" | "high" | "medium" | "low"; readonly internet_facing: boolean; readonly detected_ms: number; }
export function vulnerabilityDetected(i: VulnerabilityInput): { sla_due_ms: number; remediation_due: PlainDate; timer_code: "SM_VULN_REMEDIATION_SLA"; breach_severity: "sev1" | "sev2" | "sev3" | "sev4"; row: Record<string, unknown>; event: EventDraft } {
  const slaMs = vulnRemediationDueMs(i.detected_ms, i.severity, i.internet_facing);
  const due = wallClock(slaMs, ET).date;
  const sev = i.severity === "critical" ? "sev1" : i.severity === "high" ? "sev2" : i.severity === "medium" ? "sev3" : "sev4";
  const row = { id: i.vulnerability_id, asset_id: i.asset_id, cve: i.cve, severity: i.severity, internet_facing: i.internet_facing, detected_at: iso(i.detected_ms), sla_due_at: iso(slaMs), remediated_at: null, exception_id: null };
  return { sla_due_ms: slaMs, remediation_due: due, timer_code: "SM_VULN_REMEDIATION_SLA", breach_severity: sev, row, event: { type: "vulnerability.detected", occurredAt: iso(i.detected_ms), aggregate: { kind: "vulnerability", id: i.vulnerability_id }, payload: { ...row, remediation_due: due, breach_severity: sev } } };
}
/** Technology Guide / rule 5 / timer row `FNMA_TECHGUIDE_CREDENTIAL_RESET_90D` (_365D for system IDs): reset every 90 calendar days for human Fannie Mae credentials and 365 for Fannie Mae System IDs; at breach the credential is auto-disabled and a sev-1 raised — for both kinds (19.2-T11). */
export function credentialResetClock(kind: "human" | "fnma_system_id", lastResetOn: PlainDate, today: PlainDate): { due: PlainDate; period_days: 90 | 365; timer_code: "FNMA_TECHGUIDE_CREDENTIAL_RESET_90D"; auto_disable: true; disabled_on: PlainDate | null; escalation: Escalation | null; action: { action: "idp.disableIdentity"; reason: string } | null } {
  const period = kind === "human" ? 90 : 365;
  const due = addDays(lastResetOn, period);
  const breached = today >= due;
  return { due, period_days: period, timer_code: "FNMA_TECHGUIDE_CREDENTIAL_RESET_90D", auto_disable: true, disabled_on: breached ? today : null, escalation: breached ? { kind: "sev1", owner_role: "ciso", reason: `${kind === "human" ? "human Fannie Mae credential" : "Fannie Mae System ID"} not reset within ${period} days of ${lastResetOn}: auto-disabled ${today}` } : null, action: breached ? { action: "idp.disableIdentity", reason: `credential reset overdue since ${due}` } : null };
}
/** Timer table `FNMA_SUPP_POST_INCIDENT_ASSESSMENT`: engage +10 business_days_servicer; complete +90 calendar days — both anchored on `identified_at`. */
export function postIncidentAssessmentClocks(identifiedMs: number, cal: Calendar = servicer): { engage_by: PlainDate; complete_by: PlainDate; complete_by_ms: number } {
  const on = wallClock(identifiedMs, ET).date;
  const complete = addDays(on, 90);
  return { engage_by: addBusinessDays(on, 10, cal), complete_by: complete, complete_by_ms: endOfDayMs(complete) };
}

// ============================================================ IR runbook (AI-first and AI-off)
export interface RunbookStep { readonly step: string; readonly timer_codes: readonly string[]; readonly templates: readonly string[]; readonly tools: readonly string[]; readonly human_act: "officer" | "attorney" | "ciso" | null; }
export interface Runbook { readonly executor: "security-records" | "human_ir_lead"; readonly console_role: "ciso" | null; readonly steps: readonly RunbookStep[]; readonly timers: readonly ArmedTimer[]; readonly templates: readonly string[]; }
export const RUNBOOK_STEPS: readonly RunbookStep[] = [
  { step: "triage", timer_codes: [], templates: [], tools: ["siem.query", "incident.setSeverity"], human_act: null },
  { step: "identified", timer_codes: ["SM_PARTNER_INCIDENT_NOTICE_24H", "FNMA_SUPP_INCIDENT_NOTICE_36H", "FNMA_FORM101_DATA_INCIDENT_NOTICE_36H", "SM_NYDFS_DETERMINATION_48H"], templates: ["NTC_PARTNER_INCIDENT_24H", "NTC_FNMA_INCIDENT_36H", "NTC_FNMA_FORM101_INCIDENT"], tools: ["notices.draft", "timers.read"], human_act: "officer" },
  { step: "contained", timer_codes: [], templates: [], tools: ["idp.disableIdentity", "vault.rotateSecret", "cloud.isolateHost", "network.blockEgress"], human_act: null },
  { step: "scoped", timer_codes: ["FTC_314_4J_NOTIFICATION_EVENT_30D", "STATE_BREACH_CONSUMER_NOTICE_NY_30D", "STATE_BREACH_REGULATOR_NOTICE_NY", "STATE_BREACH_CRA_NOTICE_NY_5000"], templates: ["NTC_FTC_314_4J", "NTC_BREACH_CRA"], tools: ["incident.scope", "portal_task.create"], human_act: "officer" },
  { step: "determined", timer_codes: ["NYDFS_500_17A_INCIDENT_NOTICE_72H", "NYDFS_500_17C_EXTORTION_PAYMENT_NOTICE_24H", "NYDFS_500_17C_EXTORTION_EXPLANATION_30D"], templates: ["NTC_NYDFS_500_17A", "NTC_NYDFS_500_17C_EXTORTION_24H"], tools: ["portal_task.create"], human_act: "officer" },
  { step: "post_incident", timer_codes: ["FNMA_SUPP_POST_INCIDENT_ASSESSMENT", "SM_INCIDENT_ROOT_CAUSE_30D"], templates: [], tools: ["controls.runTest", "exceptions.propose"], human_act: "attorney" },
];
/**
 * Human path (AI off): the IR runbook is executable by the CISO team from the ops console with the same timers and
 * templates; only the executor changes. The AI path's clocks are the agent's own computation (triageIncident); the
 * human path's are whatever the platform armed from the `security.incident.identified` event the console emitted
 * (`armed_timers`, read through `timers.read`) — so equality between the two is a property of the registry, not of
 * this function.
 */
export function irRunbook(i: TriageInput & { readonly ai_first: boolean; readonly armed_timers?: readonly ArmedTimer[] }): Runbook {
  const timers = i.ai_first ? triageIncident(i).timers : sortTimers(i.armed_timers ?? []);
  return { executor: i.ai_first ? "security-records" : "human_ir_lead", console_role: i.ai_first ? null : "ciso", steps: RUNBOOK_STEPS, timers, templates: [...new Set(RUNBOOK_STEPS.flatMap((s) => s.templates))] };
}

// ============================================================ security-program lifecycle (console commands, ingestion handlers, Sentinel)
/** The append-only log the lifecycle writes to (MemoryEventStore / the Postgres store share this shape). */
export type SecurityEventSink = { append<P extends Record<string, unknown>>(input: EventInput<P>): DomainEvent<P>; all(): readonly DomainEvent[] };
export interface SecurityOpsContext { readonly events: SecurityEventSink; readonly actor: Actor; readonly now: string; }
/** A refusal a console command makes before writing anything (the tools re-throw it as a bus refusal with the same code). */
export class SecurityOpsRefused extends Error { readonly code: string; readonly citation: string; constructor(code: string, citation: string, reason: string) { super(`${code}: ${reason}`); this.name = "SecurityOpsRefused"; this.code = code; this.citation = citation; } }
const refuseUnless = (ok: boolean, code: string, citation: string, reason: string): void => { if (!ok) throw new SecurityOpsRefused(code, citation, reason); };
const roleOf = (a: Actor): string | null => (a.kind === "human" ? a.role ?? null : null);
const requireRole = (a: Actor, roles: readonly string[], code: string, citation: string, what: string): void => refuseUnless(roleOf(a) !== null && roles.includes(roleOf(a)!), code, citation, `${what} is a ${roles.join("/")} act, not ${a.kind}:${a.id}${a.role ? ` (${a.role})` : ""}`);
const need = (v: unknown, name: string): void => { if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) throw new RangeError(`${name} is required`); };
const civil = (isoOrMs: string | number): PlainDate => wallClock(typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs), ET).date;
export const PROGRAM_AGGREGATE = { kind: "security_program", id: "POL-SEC-01" } as const;
export const CONTAINMENT_EVENT_TYPES: readonly string[] = ["identity.disabled", "identity.credential.reset", "host.isolated", "network.egress.blocked"];
const incidentAgg = (id: string) => ({ kind: INCIDENT_AGGREGATE, id });

// ---- incident lifecycle (state machine: identified → contained → scoped → notified → eradicated → recovered → post_incident → closed)
export type IncidentTransition = "contained" | "eradicated" | "recovered" | "closed";
const TRANSITION_ORDER: readonly string[] = ["open", "identified", "contained", "scoped", "notified", "eradicated", "recovered", "post_incident", "closed"];
export interface TransitionFacts { readonly incident_id: string; readonly from: string; readonly to: IncidentTransition; readonly notices_due: number; readonly notices_sent_or_documented: number; readonly lessons_learned_published?: boolean; readonly severity?: Severity | null; readonly independent_assessment_completed?: boolean; }
/** State machine: transitions run forward only; `notified` (hence anything after it) requires every `incident_notices` row with a due date to be sent or documented as not required; `closed` needs the lessons learned published and, for an S1, the independent assessment completed. `security.incident.recovered` carries `recovered_at` — the SM_INCIDENT_ROOT_CAUSE_30D anchor. */
export function transitionIncident(ctx: SecurityOpsContext, f: TransitionFacts): { event: DomainEvent; status: IncidentTransition } {
  need(f.incident_id, "incident_id");
  refuseUnless(TRANSITION_ORDER.indexOf(f.to) > TRANSITION_ORDER.indexOf(f.from), "INCIDENT_STATE_ORDER", "19.2 state machine", `${f.from} → ${f.to} runs backwards`);
  if (TRANSITION_ORDER.indexOf(f.to) > TRANSITION_ORDER.indexOf("notified")) refuseUnless(f.notices_sent_or_documented >= f.notices_due, "NOTICES_OUTSTANDING", "19.2 state machine: transitions to `notified` require every incident_notices row with a due date to be sent or documented as not required", `${f.notices_due - f.notices_sent_or_documented} notice(s) with a due date neither sent nor documented`);
  if (f.to === "closed") { refuseUnless(f.lessons_learned_published === true, "LESSONS_LEARNED_REQUIRED", "19.2 state machine: post_incident (root cause, lessons learned) precedes closed", "lessons learned not published"); if (f.severity === "S1") refuseUnless(f.independent_assessment_completed === true, "POST_INCIDENT_ASSESSMENT_REQUIRED", "Fannie Mae Supplement: independent security assessment upon the occurrence of any Cybersecurity Incident", "S1 closes only after the independent assessment"); }
  const event = ctx.events.append({ type: `security.incident.${f.to}`, aggregate: incidentAgg(f.incident_id), actor: ctx.actor, payload: { incident_id: f.incident_id, from: f.from, status: f.to, [`${f.to}_at`]: ctx.now, by: `${ctx.actor.kind}:${ctx.actor.id}` } });
  return { event, status: f.to };
}
/** SM_NYDFS_DETERMINATION_48H's second satisfier: the CISO's documented "not an incident" decision closes the 48-hour policy clock without starting the 72-hour NYDFS clock (`cybersecurity_incident=false` — see timers-19-2.ts NYDFS_500_17A_INCIDENT_NOTICE_72H). */
export function determineNotAnIncident(ctx: SecurityOpsContext, i: { incident_id: string; rationale: string; decision_document_id: string }): DomainEvent {
  need(i.incident_id, "incident_id"); need(i.rationale, "rationale"); need(i.decision_document_id, "decision_document_id");
  requireRole(ctx.actor, ["ciso"], "DETERMINATION_CISO", "19.2 human actors: CISO (severity confirmation, determination)", "the NYDFS determination");
  return ctx.events.append({ type: "security.incident.determined", aggregate: incidentAgg(i.incident_id), actor: ctx.actor, payload: { incident_id: i.incident_id, cybersecurity_incident: false, outcome: "not_an_incident", prong: null, rationale: i.rationale, decision_document_id: i.decision_document_id, determined_at: ctx.now } });
}
/** `lessons_learned.published` (SM_INCIDENT_ROOT_CAUSE_30D): the root cause and the lessons-learned document within 30 days of recovery. */
export function publishLessonsLearned(ctx: SecurityOpsContext, i: { incident_id: string; root_cause: string; lessons_learned_document_id: string; recovered_at: string }): { event: DomainEvent; days_after_recovery: number; within_30_days: boolean } {
  need(i.incident_id, "incident_id"); need(i.root_cause, "root_cause"); need(i.lessons_learned_document_id, "lessons_learned_document_id"); need(i.recovered_at, "recovered_at");
  const days = daysBetween(civil(i.recovered_at), civil(ctx.now));
  const event = ctx.events.append({ type: "lessons_learned.published", aggregate: incidentAgg(i.incident_id), actor: ctx.actor, payload: { incident_id: i.incident_id, root_cause: i.root_cause, lessons_learned_document_id: i.lessons_learned_document_id, recovered_at: i.recovered_at, published_at: ctx.now, days_after_recovery: days } });
  return { event, days_after_recovery: days, within_30_days: days <= 30 };
}
/** `extortion.payment.made` (NYDFS 500.17(c) 24 h / 30 d clocks): a human, officer-authorized act — the agent may not pay or negotiate extortion. */
export function recordExtortionPayment(ctx: SecurityOpsContext, i: { incident_id: string; amount_cents: bigint; asset: string; recipient_descriptor: string; authorized_by: string; paid_at: string; counsel_document_id?: string | null }): { event: DomainEvent; notice_due_ms: number; explanation_due: PlainDate } {
  need(i.incident_id, "incident_id"); need(i.paid_at, "paid_at"); need(i.authorized_by, "authorized_by");
  refuseUnless(ctx.actor.kind !== "agent", "NO_AGENT_EXTORTION", "19.2 escalations: the agent may not pay or negotiate extortion", "an extortion payment is recorded by an officer, never by the agent");
  requireRole(ctx.actor, ["officer"], "EXTORTION_OFFICER", "19.2 escalations: the agent may not pay or negotiate extortion; regulatory notices are officer acts", "recording an extortion payment");
  refuseUnless(typeof i.amount_cents === "bigint" && i.amount_cents > 0n, "AMOUNT_CENTS", "bigint cents", "amount_cents must be a positive bigint");
  const paidMs = Date.parse(i.paid_at); const explanationDue = addDays(civil(paidMs), 30);
  const event = ctx.events.append({ type: "extortion.payment.made", occurredAt: i.paid_at, aggregate: incidentAgg(i.incident_id), actor: ctx.actor, payload: { incident_id: i.incident_id, amount_cents: i.amount_cents, asset: i.asset, recipient_descriptor: i.recipient_descriptor, authorized_by: i.authorized_by, paid_by_agent: false, paid_at: i.paid_at, notice_due_at: iso(paidMs + 24 * H), explanation_due: explanationDue, counsel_document_id: i.counsel_document_id ?? null } });
  return { event, notice_due_ms: paidMs + 24 * H, explanation_due: explanationDue };
}
/** `sec.filing.made` (FNMA_SUPP_SEC_FILING_COPY_36H): an SEC filing about the incident, if any (n/a unless public) — a copy goes to Fannie Mae within 36 hours of filing. */
export function recordSecFiling(ctx: SecurityOpsContext, i: { incident_id: string; form: string; filed_at: string; accession_no: string; document_id: string }): { event: DomainEvent; copy_due_ms: number } {
  need(i.incident_id, "incident_id"); need(i.form, "form"); need(i.filed_at, "filed_at"); need(i.document_id, "document_id");
  requireRole(ctx.actor, ["officer", "attorney"], "SEC_FILING_HUMAN", "19.2 human actors: officer / attorney", "recording an SEC filing");
  const filedMs = Date.parse(i.filed_at);
  const event = ctx.events.append({ type: "sec.filing.made", occurredAt: i.filed_at, aggregate: incidentAgg(i.incident_id), actor: ctx.actor, payload: { incident_id: i.incident_id, form: i.form, filed_at: i.filed_at, filed_date: civil(filedMs), accession_no: i.accession_no, document_id: i.document_id, fnma_copy_due_at: iso(filedMs + 36 * H) } });
  return { event, copy_due_ms: filedMs + 36 * H };
}
/** The officer's send: `incident_notices` row + `incident.notice.sent{recipient, template_code, kind?}` — every regulatory or partner notice is an officer act, and the timer stays open until evidence is attached (integrations: failure handling). `verified_recipients`, when given, is the registry the address must be in. */
export function sendIncidentNotice(ctx: SecurityOpsContext, i: Omit<NoticeSentInput, "sent_ms" | "sent_by_role"> & { sent_at?: string; address?: string; verified_recipients?: ReadonlySet<string> }): { row: Record<string, unknown>; event: DomainEvent } {
  need(i.incident_id, "incident_id"); need(i.recipient, "recipient"); need(i.template_code, "template_code");
  requireRole(ctx.actor, ["officer"], "NOTICE_OFFICER", "19.2 escalations: every regulatory or partner notice is sent by an officer", `the ${i.recipient} notice`);
  refuseUnless(!!i.evidence_document_id, "NOTICE_EVIDENCE", "19.2 integrations: the timer stays open until evidence is attached", "attach the sent copy / acknowledgement / portal receipt as evidence_document_id");
  if (i.verified_recipients && i.address) refuseUnless(i.verified_recipients.has(i.address), "VERIFIED_RECIPIENTS_ONLY", "19.2 guardrails: notices go only to recipients in the verified registry", `${i.address} is not in the verified recipient registry`);
  const sentAt = i.sent_at ?? ctx.now;
  const r = incidentNoticeSent({ incident_id: i.incident_id, recipient: i.recipient, template_code: i.template_code, sent_ms: Date.parse(sentAt), sent_by_role: "officer", channel: i.channel, evidence_document_id: i.evidence_document_id ?? null, ...(i.kind ? { kind: i.kind } : {}) });
  const event = ctx.events.append({ type: r.event.type, occurredAt: r.event.occurredAt, aggregate: r.event.aggregate, actor: ctx.actor, payload: { ...r.event.payload, sent_by: `${ctx.actor.kind}:${ctx.actor.id}`, ...(i.address ? { address: i.address } : {}) } });
  return { row: r.row, event };
}
/** NY GBL §899-aa(8)(a): each regulator send is an `incident.notice.sent`; once the AG, Department of State, State Police and (Part 500) DFS have all been notified the composite `incident.state_regulator_notices.sent{state}` closes STATE_BREACH_REGULATOR_NOTICE_NY. */
export function recordStateRegulatorNotices(ctx: SecurityOpsContext, i: { state: string; incident_id: string; sends: readonly { recipient: string; template_code: string; sent_at: string; channel: string; evidence_document_id: string }[]; prior?: readonly { recipient: string; sent_ms: number }[] }): { sent: DomainEvent[]; complete: boolean; missing: readonly string[]; composite: DomainEvent | null } {
  need(i.state, "state"); need(i.incident_id, "incident_id"); need(i.sends, "sends");
  const sent = i.sends.map((s) => sendIncidentNotice(ctx, { incident_id: i.incident_id, recipient: s.recipient as NoticeRecipient, template_code: s.template_code, sent_at: s.sent_at, channel: s.channel, evidence_document_id: s.evidence_document_id }).event);
  const all = [...(i.prior ?? []), ...i.sends.map((s) => ({ recipient: s.recipient, sent_ms: Date.parse(s.sent_at) }))];
  const c = stateRegulatorNoticesComplete(i.state, i.incident_id, all);
  const composite = c.event ? ctx.events.append({ type: c.event.type, occurredAt: c.event.occurredAt, aggregate: c.event.aggregate, actor: ctx.actor, payload: c.event.payload }) : null;
  return { sent, complete: c.complete, missing: c.missing, composite };
}
/** Ingestion of the print-mail completion feed for a state's consumer notices: `consumer_notices.mailed{state, all_residents=true}` only when every affected resident has a mailed or substitute notice (STATE_BREACH_CONSUMER_NOTICE_<XX>). */
export function recordConsumerNoticesMailed(ctx: SecurityOpsContext, i: { state: string; incident_id: string; residents: number; mailed: number; substitute: number; mailed_at: string; print_mail_batch_id: string; template_code?: string }): { all_residents: boolean; outstanding: number; event: DomainEvent | null } {
  need(i.state, "state"); need(i.incident_id, "incident_id"); need(i.print_mail_batch_id, "print_mail_batch_id");
  refuseUnless(Number.isInteger(i.residents) && Number.isInteger(i.mailed) && Number.isInteger(i.substitute) && i.residents >= 0 && i.mailed >= 0 && i.substitute >= 0, "COUNTS", "19.2 data model: incident_affected_persons counts", "residents, mailed and substitute are non-negative integers");
  const m = consumerNoticesMailed(i.state, i.incident_id, i.residents, i.mailed, i.substitute, Date.parse(i.mailed_at));
  const event = m.event ? ctx.events.append({ type: m.event.type, occurredAt: m.event.occurredAt, aggregate: m.event.aggregate, actor: ctx.actor, payload: { ...m.event.payload, print_mail_batch_id: i.print_mail_batch_id, template_code: i.template_code ?? `NTC_BREACH_CONSUMER_${i.state}`, channel: "mail" } }) : null;
  return { all_residents: m.all_residents, outstanding: m.outstanding, event };
}

// ---- law-enforcement delay (edge cases: pauses consumer/state clocks where the state allows; never the Fannie Mae or NYDFS clocks)
export interface TimerInstanceLike { readonly id: string; readonly code: string; readonly subject: { readonly kind: string; readonly id: string }; readonly status: string; readonly dueDate?: PlainDate; readonly dueAt?: number; readonly armedAt: string; }
export interface StateClockPort { open(): readonly TimerInstanceLike[]; cancel(id: string, reason: string, actor: Actor): void; arm(def: TimerDef, trigger: DomainEvent): unknown; get(code: string): TimerDef | undefined; }
const STATE_CLOCK = /^STATE_BREACH_/;
const NEVER_PAUSED = /^(FNMA_|NYDFS_|SM_PARTNER_|SM_NYDFS_)/;
/** A documented written law-enforcement request pauses the incident's state consumer/regulator/CRA clocks (the instances are cancelled with the request as the reason and re-armed on lift with the days that remained); the Fannie Mae, Form 101, partner and NYDFS clocks are never paused (N.Y. Gen. Bus. Law §899-aa(4); spec edge cases). */
export function lawEnforcementDelay(ctx: SecurityOpsContext, timers: StateClockPort, i: { incident_id: string; agency: string; request_document_id: string; requested_on: PlainDate; states: readonly string[] }): { event: DomainEvent; paused: readonly { timer_id: string; code: string; remaining_days: number }[]; not_pausable: readonly string[] } {
  need(i.incident_id, "incident_id"); need(i.agency, "agency"); need(i.request_document_id, "request_document_id"); need(i.states, "states");
  requireRole(ctx.actor, ["attorney"], "LAW_ENFORCEMENT_DELAY_ATTORNEY", "19.2 escalations: law-enforcement liaison, delay requests and privilege decisions → attorney", "a law-enforcement delay");
  const mine = timers.open().filter((t) => t.subject.kind === INCIDENT_AGGREGATE && t.subject.id === i.incident_id && t.status === "armed");
  const not_pausable = mine.filter((t) => NEVER_PAUSED.test(t.code)).map((t) => t.code);
  const paused = mine.filter((t) => STATE_CLOCK.test(t.code) && i.states.some((s) => t.code.includes(`_${s}`))).map((t) => { const remaining = t.dueDate ? Math.max(0, daysBetween(i.requested_on, t.dueDate)) : 0; timers.cancel(t.id, `law-enforcement delay: ${i.agency} written request ${i.request_document_id} (§899-aa(4)); ${remaining} day(s) remained`, ctx.actor); return { timer_id: t.id, code: t.code, remaining_days: remaining }; });
  const event = ctx.events.append({ type: "security.incident.law_enforcement_delay.recorded", aggregate: incidentAgg(i.incident_id), actor: ctx.actor, payload: { incident_id: i.incident_id, agency: i.agency, request_document_id: i.request_document_id, requested_on: i.requested_on, states: [...i.states], paused: paused.map((p) => ({ code: p.code, remaining_days: p.remaining_days })), not_pausable } });
  return { event, paused, not_pausable };
}
/** The agency's determination that notice no longer impedes the investigation lifts the delay: each paused row is re-armed so it falls due the remaining days after the lift (the re-arm event carries the anchor the row reads, with the original discovery date alongside). */
export function lawEnforcementDelayLifted(ctx: SecurityOpsContext, timers: StateClockPort, i: { incident_id: string; lifted_on: PlainDate; original_discovered_at: PlainDate; paused: readonly { code: string; remaining_days: number }[] }): { event: DomainEvent; rearmed: readonly { code: string; due: PlainDate }[] } {
  need(i.incident_id, "incident_id"); need(i.lifted_on, "lifted_on"); need(i.paused, "paused");
  requireRole(ctx.actor, ["attorney"], "LAW_ENFORCEMENT_DELAY_ATTORNEY", "19.2 escalations: law-enforcement liaison → attorney", "lifting a law-enforcement delay");
  const rearmed: { code: string; due: PlainDate }[] = [];
  const event = ctx.events.append({ type: "security.incident.law_enforcement_delay.lifted", aggregate: incidentAgg(i.incident_id), actor: ctx.actor, payload: { incident_id: i.incident_id, lifted_on: i.lifted_on, original_discovered_at: i.original_discovered_at, resumed: i.paused.map((p) => ({ code: p.code, due: addDays(i.lifted_on, p.remaining_days) })) } });
  for (const p of i.paused) {
    const def = timers.get(p.code); if (!def) continue;
    const due = addDays(i.lifted_on, p.remaining_days);
    // the row's anchor field (discovered_at / consumer_notice_due) is set so that anchor + the row's offset = lift + remaining days; the original discovery date travels alongside
    const anchorValue = def.anchorField === "consumer_notice_due" ? due : addDays(due, -30);
    timers.arm(def, { ...event, payload: { ...event.payload, [def.anchorField ?? "discovered_at"]: anchorValue, resumed_due: due, anchor_basis: "law_enforcement_delay_lifted: remaining days re-applied (§899-aa(4))" } });
    rearmed.push({ code: p.code, due });
  }
  return { event, rearmed };
}

// ---- CISO approvals, containment counting, current severity (read from the log, never from a caller flag)
export type CisoApprovalKind = "containment_blast_radius" | "containment_rate_limit" | "severity_downgrade";
/** `ciso.approval.recorded`: the CISO's approval the guardrails look for — a human CISO act (the agent's own `ciso_approved` flag is never an approval). */
export function recordCisoApproval(ctx: SecurityOpsContext, i: { kind: CisoApprovalKind; incident_id: string; action?: string; max_targets?: number; escalation_id?: string | null; rationale: string }): DomainEvent {
  need(i.kind, "kind"); need(i.incident_id, "incident_id"); need(i.rationale, "rationale");
  requireRole(ctx.actor, ["ciso"], "CISO_APPROVAL", "19.2 guardrails: no more than N identities/hosts per action without CISO approval; severity downgrade from S2 to S3 requires CISO approval", `a ${i.kind} approval`);
  return ctx.events.append({ type: "ciso.approval.recorded", aggregate: incidentAgg(i.incident_id), actor: ctx.actor, payload: { kind: i.kind, incident_id: i.incident_id, action: i.action ?? null, max_targets: i.max_targets ?? null, escalation_id: i.escalation_id ?? null, rationale: i.rationale, approved_at: ctx.now } });
}
/** The approval covering this action, if a human CISO recorded one for the incident (and, for containment, for at least this many targets). */
export function cisoApprovalFor(log: readonly DomainEvent[], q: { kind: CisoApprovalKind; incident_id: string; action?: string; targets?: number }): DomainEvent | null {
  return log.find((e) => e.type === "ciso.approval.recorded" && e.actor.kind === "human" && e.actor.role === "ciso" && e.payload.kind === q.kind && e.payload.incident_id === q.incident_id
    && (q.action === undefined || e.payload.action === null || e.payload.action === q.action) && (q.targets === undefined || e.payload.max_targets === null || Number(e.payload.max_targets) >= q.targets)) ?? null;
}
/** Agent containment actions in the trailing hour — counted from the log, never from a caller-supplied number. */
export function containmentActionsLastHour(log: readonly DomainEvent[], nowMs: number, actorId?: string): number {
  return log.filter((e) => CONTAINMENT_EVENT_TYPES.includes(e.type) && e.actor.kind === "agent" && (actorId === undefined || e.actor.id === actorId) && nowMs - Date.parse(e.occurredAt) < H && Date.parse(e.occurredAt) <= nowMs).length;
}
/** The incident's current severity as the log states it (identification, then any recorded change). */
export function currentSeverity(log: readonly DomainEvent[], incidentId: string): Severity | null {
  let sev: Severity | null = null;
  for (const e of log) { if (e.payload.incident_id !== incidentId) continue; if (e.type === "security.incident.identified" && typeof e.payload.severity === "string") sev = e.payload.severity as Severity; if (e.type === "security.incident.severity_changed" && typeof e.payload.to === "string") sev = e.payload.to as Severity; }
  return sev;
}
/** Rule 1 with the SOC record as the anchor: the SOC's confirmation, when recorded, anchors identification (a caller's later time never moves it); without one, the caller's confirmation stands in (never in the future, never later than an existing identification). */
export function identificationAnchor(i: { existing_ms: number | null; soc_confirmed_ms: number | null; caller_confirmed_ms: number | null; now_ms: number }): { identified_ms: number; basis: "existing" | "soc_confirmation" | "caller"; refusal: string | null } {
  const soc = i.soc_confirmed_ms;
  if (soc !== null) { const r = identifiedAtFor(i.existing_ms, soc, i.now_ms); return { identified_ms: r.identified_ms, basis: r.identified_ms === soc ? "soc_confirmation" : "existing", refusal: r.refusal }; }
  const r = identifiedAtFor(i.existing_ms, i.caller_confirmed_ms ?? i.now_ms, i.now_ms);
  return { identified_ms: r.identified_ms, basis: i.existing_ms !== null && r.identified_ms === i.existing_ms ? "existing" : "caller", refusal: r.refusal };
}

// ---- Compliance Sentinel: warnings at 50/75/90 % of the Fannie Mae clock, breach handling, credential auto-disable
export const WARNING_PCTS: readonly (50 | 75 | 90)[] = [50, 75, 90];
export const WARNED_CODES: readonly string[] = ["FNMA_SUPP_INCIDENT_NOTICE_36H", "FNMA_FORM101_DATA_INCIDENT_NOTICE_36H"];
/** Breach column: "officer + CISO page at 50%/75%/90% elapsed" — `timer.warning{code, timer_id, pct}` once per threshold per instance (the log is the memory), with the page as an escalation for the caller to open. */
export function incidentClockWarnings(ctx: SecurityOpsContext, instances: readonly TimerInstanceLike[], nowMs: number = Date.parse(ctx.now)): { warnings: readonly { timer_id: string; code: string; pct: 50 | 75 | 90; event: DomainEvent }[]; escalations: readonly Escalation[] } {
  const already = new Set(ctx.events.all().filter((e) => e.type === "timer.warning").map((e) => `${e.payload.timer_id}:${e.payload.pct}`));
  const warnings: { timer_id: string; code: string; pct: 50 | 75 | 90; event: DomainEvent }[] = []; const escalations: Escalation[] = [];
  for (const t of instances) {
    if (!WARNED_CODES.includes(t.code) || t.status !== "armed" || t.dueAt === undefined) continue;
    const start = Date.parse(t.armedAt); const elapsed = (nowMs - start) / (t.dueAt - start);
    for (const pct of WARNING_PCTS) {
      if (elapsed < pct / 100 || already.has(`${t.id}:${pct}`)) continue;
      const event = ctx.events.append({ type: "timer.warning", aggregate: t.subject, actor: ctx.actor, payload: { code: t.code, timer_id: t.id, pct, elapsed_pct: Math.floor(elapsed * 100), due_at: iso(t.dueAt), page: ["officer", "ciso"] } });
      warnings.push({ timer_id: t.id, code: t.code, pct, event }); already.add(`${t.id}:${pct}`);
      escalations.push({ kind: "sev1", owner_role: "officer", by_ms: t.dueAt, reason: `${t.code} ${pct}% elapsed (due ${iso(t.dueAt)}): officer + CISO page` });
    }
  }
  return { warnings, escalations };
}
export interface BreachLike { readonly instance: TimerInstanceLike; readonly severity: 1 | 2 | 3 | 4 | null; readonly escalateTo: readonly string[]; readonly breachText: string; }
export interface SentinelPorts { evaluate(nowIso: string): readonly BreachLike[]; open(): readonly TimerInstanceLike[]; store: { get(kind: string, id: string): { data: Record<string, unknown> } | undefined; put(kind: string, id: string, data: Record<string, unknown>, by: Actor, now: string): unknown }; }
export interface SentinelResult { readonly breaches: readonly BreachLike[]; readonly warnings: ReturnType<typeof incidentClockWarnings>["warnings"]; readonly disabled: readonly string[]; readonly escalations: readonly (Escalation & { readonly timer_id?: string; readonly code?: string })[]; }
/** The Sentinel sweep: breach what is overdue (the engine), then act on the breach column — a breached FNMA_TECHGUIDE_CREDENTIAL_RESET_90D auto-disables the credential (`identity.disabled{auto=true}`, sev-1), every other breach pages its roles at its severity — and page at 50/75/90 % of the incident clocks. */
export function sentinelSweep(ctx: SecurityOpsContext, ports: SentinelPorts): SentinelResult {
  const breaches = ports.evaluate(ctx.now);
  const disabled: string[] = []; const escalations: SentinelResult["escalations"][number][] = [];
  for (const b of breaches) {
    const t = b.instance;
    if (t.code === "FNMA_TECHGUIDE_CREDENTIAL_RESET_90D") {
      const kind = t.subject.kind === "secret" ? "secrets" : "identities";
      ports.store.put(kind, t.subject.id, { disabled_at: ctx.now, disabled_reason: `credential reset overdue (${t.code} breached ${ctx.now}); auto-disabled`, auto_disabled: true, reversible: true }, ctx.actor, ctx.now);
      ctx.events.append({ type: "identity.disabled", aggregate: t.subject, actor: ctx.actor, payload: { identity_id: t.subject.id, incident_id: null, auto: true, timer_id: t.id, code: t.code, reason: "Technology Guide: credential not reset within 90 (human) / 365 (system ID) calendar days — auto-disabled at breach", reversible: true } });
      disabled.push(t.subject.id);
      escalations.push({ kind: "sev1", owner_role: "ciso", timer_id: t.id, code: t.code, reason: `${t.subject.id}: Fannie Mae credential reset overdue — auto-disabled (sev-1)` });
      continue;
    }
    const level = b.severity ?? 3; const kind = (`sev${level}`) as "sev1" | "sev2" | "sev3" | "sev4";
    escalations.push({ kind, owner_role: b.escalateTo[0] ?? (level <= 2 ? "officer" : "ciso"), timer_id: t.id, code: t.code, reason: `${t.code} breached: ${b.breachText}` });
  }
  const w = incidentClockWarnings(ctx, ports.open());
  return { breaches, warnings: w.warnings, disabled, escalations: [...escalations, ...w.escalations] };
}
/** 19.2-T13's "`NYDFS_500_16D_BACKUP_RESTORE_TEST_365` is `failed`": the annual row's status as the program reports it — `failed` while the latest restore test on the log failed (the engine keeps the instance armed; the failure is the control result), else the instance's own status. */
export function backupRestoreTimerStatus(instances: readonly TimerInstanceLike[], log: readonly DomainEvent[]): { status: string; latest_test: "passed" | "failed" | null; instance_status: string | null } {
  const last = [...log].reverse().find((e) => e.type === "backup_restore_test.passed" || e.type === "backup_restore_test.failed");
  const inst = instances.filter((t) => t.code === "NYDFS_500_16D_BACKUP_RESTORE_TEST_365").at(-1) ?? null;
  const latest = last ? (last.type === "backup_restore_test.failed" ? "failed" : "passed") : null;
  return { status: latest === "failed" ? "failed" : (inst?.status ?? "not_armed"), latest_test: latest, instance_status: inst?.status ?? null };
}

// ---- schedules as events (the Graphile jobs of "Inputs and triggers")
/** The 19.2 schedules the recurring rows name: `schedule.tick{cadence=daily}` (MFA / encryption / credential-age / TLS controls), `period.quarter_end` (privileged access review, firewall rules, restore test), `period.year_end` (NYDFS April 15) and `period.fiscal_year_end` (Supplement attestation for the partner's Form 582). */
export function securityProgramTicks(today: PlainDate, fiscalYearEnd: { month: number; day: number } = { month: 12, day: 31 }): EventInput[] {
  const sched: Actor = { kind: "system", id: "scheduler" }; const { y, m, d } = parts(today);
  const out: EventInput[] = [{ type: "schedule.tick", actor: sched, payload: { cadence: "daily", job: "security-control-tests", at: "06:00", tz: ET, date: today, controls: ["CTL-SEC-01", "CTL-SEC-02", "CTL-SEC-03", "CTL-SEC-16"] } }];
  if ([3, 6, 9, 12].includes(m) && d === parts(addMonths(ymd(y, m, 1), 1)).d - 1 + 0 && today === addDays(addMonths(ymd(y, m, 1), 1), -1)) out.push({ type: "period.quarter_end", actor: sched, payload: { date: today, quarter: `${y}-Q${m / 3}`, jobs: ["privileged-access-certification", "firewall-rule-review", "restore-test"] } });
  if (m === 12 && d === 31) out.push({ type: "period.year_end", actor: sched, payload: { year: y, date: today, jobs: ["nydfs-500-17b-certification"] } });
  if (m === fiscalYearEnd.month && d === fiscalYearEnd.day) out.push({ type: "period.fiscal_year_end", actor: sched, payload: { fiscal_year: y, date: today, jobs: ["supplement-attestation-form-582"] } });
  return out;
}
export function emitSecurityProgramTicks(today: PlainDate, events: SecurityEventSink, fiscalYearEnd?: { month: number; day: number }): DomainEvent[] { return securityProgramTicks(today, fiscalYearEnd).map((e) => events.append(e)); }

// ---- program evidence: the completions that arm and close the recurring rows
export interface AssessmentInput { readonly assessment_id: string; readonly performer: string; readonly independent: boolean; readonly document_id: string; readonly completed_on: PlainDate; readonly scope: "program" | "incident"; readonly incident_id?: string | null; readonly findings?: readonly unknown[]; readonly remediation_plan?: readonly unknown[]; }
/** `independent_assessment.completed{scope}`: "an independent security assessment of the control environment upon the occurrence of any Cybersecurity Incident … and at least annually … by a qualified independent auditor" — an incident-scoped one closes FNMA_SUPP_POST_INCIDENT_ASSESSMENT on its incident; a program-scoped one runs FNMA_SUPP_INDEPENDENT_ASSESSMENT_365. */
export function completeIndependentAssessment(ctx: SecurityOpsContext, i: AssessmentInput): { event: DomainEvent; next_due_on: PlainDate | null } {
  need(i.assessment_id, "assessment_id"); need(i.performer, "performer"); need(i.document_id, "document_id"); need(i.completed_on, "completed_on");
  refuseUnless(i.independent, "ASSESSOR_INDEPENDENT", "Fannie Mae Supplement: independent security assessment by a qualified independent auditor", `${i.performer} is not independent`);
  if (i.scope === "incident") need(i.incident_id, "incident_id");
  const nextDue = i.scope === "program" ? addDays(i.completed_on, 365) : null;
  const event = ctx.events.append({ type: "independent_assessment.completed", occurredAt: `${i.completed_on}T17:00:00.000Z`, aggregate: i.scope === "incident" ? incidentAgg(i.incident_id!) : PROGRAM_AGGREGATE, actor: ctx.actor, payload: { assessment_id: i.assessment_id, scope: i.scope, incident_id: i.incident_id ?? null, performer: i.performer, independent: true, document_id: i.document_id, completed_on: i.completed_on, findings: [...(i.findings ?? [])], remediation_plan: [...(i.remediation_plan ?? [])], next_due_on: nextDue, kind: "independent_assessment" } });
  return { event, next_due_on: nextDue };
}
export interface PenTestInput { readonly pen_test_id: string; readonly period: string; readonly performer: string; readonly independent_third_party: boolean; readonly document_id: string; readonly completed_on: PlainDate; readonly findings?: readonly unknown[]; readonly remediation_plan?: readonly unknown[]; readonly material_change_trigger?: boolean; }
/** `pen_test.completed` (FNMA_SUPP_PENTEST_ANNUAL_365; also FTC 314.4(d)(2)(i) and NYDFS 500.5(a)(1)): an independent third-party test with a risk-rated remediation plan; the `pen_tests` row. */
export function completePenTest(ctx: SecurityOpsContext, i: PenTestInput): { event: DomainEvent; row: Record<string, unknown>; next_due_on: PlainDate } {
  need(i.pen_test_id, "pen_test_id"); need(i.performer, "performer"); need(i.document_id, "document_id"); need(i.completed_on, "completed_on"); need(i.period, "period");
  refuseUnless(i.independent_third_party, "PENTEST_INDEPENDENT", "Fannie Mae Supplement: an independent third-party penetration test that is conducted at least annually", `${i.performer} is not an independent third party`);
  refuseUnless((i.findings ?? []).length === 0 || (i.remediation_plan ?? []).length > 0, "PENTEST_REMEDIATION_PLAN", "Fannie Mae Supplement: regular scanning and risk-rated remediation", "findings without a remediation plan");
  const nextDue = addDays(i.completed_on, 365);
  const row = { id: i.pen_test_id, period: i.period, performer: i.performer, independent_third_party: true, report_document_id: i.document_id, findings: [...(i.findings ?? [])], remediation_plan: [...(i.remediation_plan ?? [])], material_change_trigger: i.material_change_trigger ?? false, completed_at: `${i.completed_on}T17:00:00.000Z`, next_due_on: nextDue, satisfies_timer_codes: ["FNMA_SUPP_PENTEST_ANNUAL_365"] };
  const event = ctx.events.append({ type: "pen_test.completed", occurredAt: row.completed_at, aggregate: PROGRAM_AGGREGATE, actor: ctx.actor, payload: { ...row, completed_on: i.completed_on, kind: "pen_test" } });
  return { event, row, next_due_on: nextDue };
}
/** `vulnerability_assessment.completed` (FTC_314_4D2_VULN_ASSESSMENT_180): "vulnerability assessments … at least every six months and whenever there are material changes". */
export function completeVulnerabilityAssessment(ctx: SecurityOpsContext, i: { assessment_id: string; performer: string; document_id: string; completed_on: PlainDate; after_material_change?: boolean; assets_in_scope: number; open_findings: number }): { event: DomainEvent; next_due_on: PlainDate } {
  need(i.assessment_id, "assessment_id"); need(i.performer, "performer"); need(i.document_id, "document_id"); need(i.completed_on, "completed_on");
  refuseUnless(Number.isInteger(i.assets_in_scope) && i.assets_in_scope > 0, "ASSESSMENT_SCOPE", "16 CFR 314.4(d)(2)(ii): systemic vulnerability assessment of the information systems", "assets_in_scope must be a positive integer");
  const nextDue = addMonths(i.completed_on, 6);
  const event = ctx.events.append({ type: "vulnerability_assessment.completed", occurredAt: `${i.completed_on}T17:00:00.000Z`, aggregate: PROGRAM_AGGREGATE, actor: ctx.actor, payload: { assessment_id: i.assessment_id, performer: i.performer, document_id: i.document_id, completed_on: i.completed_on, after_material_change: i.after_material_change ?? false, assets_in_scope: i.assets_in_scope, open_findings: i.open_findings, next_due_on: nextDue } });
  return { event, next_due_on: nextDue };
}
export const RISK_ASSESSMENT_CRITERIA: readonly string[] = ["risk_evaluation_criteria", "cia_assessment_criteria", "safeguard_adequacy_and_mitigation"];
/** `risk_assessment.approved` (FTC_314_4B_RISK_ASSESSMENT_365): the **written** risk assessment with 314.4(b)(1)'s three criteria, approved by the Qualified Individual (also the Supplement's annual threat risk assessment). */
export function approveRiskAssessment(ctx: SecurityOpsContext, i: { risk_assessment_id: string; document_id: string; approved_on: PlainDate; written: boolean; criteria: Readonly<Record<string, boolean>>; period: string }): { event: DomainEvent; next_due_on: PlainDate } {
  need(i.risk_assessment_id, "risk_assessment_id"); need(i.document_id, "document_id"); need(i.approved_on, "approved_on"); need(i.period, "period");
  requireRole(ctx.actor, ["ciso", "officer"], "RISK_ASSESSMENT_APPROVER", "16 CFR 314.4(a)/(b): the Qualified Individual's written risk assessment", "approving the risk assessment");
  refuseUnless(i.written, "RISK_ASSESSMENT_WRITTEN", "16 CFR 314.4(b): the risk assessment shall be written", "an unwritten risk assessment cannot be approved");
  const missing = RISK_ASSESSMENT_CRITERIA.filter((c) => i.criteria[c] !== true);
  refuseUnless(missing.length === 0, "RISK_ASSESSMENT_CRITERIA", "16 CFR 314.4(b)(1)(i)–(iii): criteria for evaluating risks, for assessing confidentiality/integrity/availability, and for the adequacy of safeguards", `missing criteria: ${missing.join(", ")}`);
  const nextDue = addDays(i.approved_on, 365);
  const event = ctx.events.append({ type: "risk_assessment.approved", occurredAt: `${i.approved_on}T17:00:00.000Z`, aggregate: PROGRAM_AGGREGATE, actor: ctx.actor, payload: { risk_assessment_id: i.risk_assessment_id, document_id: i.document_id, approved_on: i.approved_on, approved_by: `${ctx.actor.kind}:${ctx.actor.id}`, written: true, criteria: RISK_ASSESSMENT_CRITERIA, period: i.period, next_due_on: nextDue } });
  return { event, next_due_on: nextDue };
}
export const BOARD_REPORT_SECTIONS: readonly string[] = ["program_status", "risk_assessment", "control_decisions", "service_providers", "test_results", "security_events", "recommendations"];
/** `board.report.delivered{kind=security}` (FTC_314_4I_BOARD_REPORT_365; NYDFS 500.4(c)): the written report to the board with 314.4(i)(1)–(2)'s content — program status, risk assessment, control decisions, service providers, test results, security events and recommendations — compiled from the control results, vulnerabilities and incidents (rule 11). */
export function deliverBoardReport(ctx: SecurityOpsContext, i: { report_id: string; period: string; document_id: string; delivered_on: PlainDate; sections: Readonly<Record<string, unknown>>; board_report_items?: readonly string[] }): { event: DomainEvent; next_due_on: PlainDate } {
  need(i.report_id, "report_id"); need(i.period, "period"); need(i.document_id, "document_id"); need(i.delivered_on, "delivered_on");
  requireRole(ctx.actor, ["ciso", "officer"], "BOARD_REPORT_QI", "16 CFR 314.4(i): the Qualified Individual reports in writing to the board", "delivering the board report");
  const missing = BOARD_REPORT_SECTIONS.filter((s) => i.sections[s] === undefined || i.sections[s] === null || i.sections[s] === "");
  refuseUnless(missing.length === 0, "BOARD_REPORT_CONTENT", "16 CFR 314.4(i)(1)–(2): overall status and compliance; material matters — risk assessment, risk management and control decisions, service provider arrangements, results of testing, security events and management's responses, recommendations", `missing sections: ${missing.join(", ")}`);
  const nextDue = addDays(i.delivered_on, 365);
  const event = ctx.events.append({ type: "board.report.delivered", occurredAt: `${i.delivered_on}T17:00:00.000Z`, aggregate: PROGRAM_AGGREGATE, actor: ctx.actor, payload: { kind: "security", report_id: i.report_id, period: i.period, document_id: i.document_id, delivered_on: i.delivered_on, sections: BOARD_REPORT_SECTIONS, board_report_items: [...(i.board_report_items ?? [])], template_code: "RPT_BOARD_SECURITY_ANNUAL", next_due_on: nextDue } });
  return { event, next_due_on: nextDue };
}
/** `supplement_attestation.signed` (FNMA_SUPP_ATTESTATION_ANNUAL): the officer's written attestation that the program meets the Supplement, delivered to the partner for its Form 582 (due the partner's Form 582 due date − 30 days). */
export function signSupplementAttestation(ctx: SecurityOpsContext, i: { attestation_id: string; period: string; document_id: string; form_582_due: PlainDate; signed_on: PlainDate; assessor: string; assessment_completed_on: PlainDate; pen_test_completed_on: PlainDate; exceptions_open: boolean; exceptions_summary?: string }): { event: DomainEvent; attestation_due: PlainDate; on_time: boolean } {
  need(i.attestation_id, "attestation_id"); need(i.period, "period"); need(i.document_id, "document_id"); need(i.form_582_due, "form_582_due"); need(i.signed_on, "signed_on"); need(i.assessor, "assessor");
  requireRole(ctx.actor, ["officer"], "ATTESTATION_OFFICER", "Fannie Mae Supplement: written attestation executed by a duly authorized corporate officer", "signing the Supplement attestation");
  refuseUnless(daysBetween(i.assessment_completed_on, i.signed_on) <= 365 && daysBetween(i.pen_test_completed_on, i.signed_on) <= 365, "ATTESTATION_BASIS_STALE", "Fannie Mae Supplement: independent assessment and penetration test at least annually", "the assessment or pen test on which the attestation rests is older than 365 days");
  if (i.exceptions_open) need(i.exceptions_summary, "exceptions_summary");
  const due = addDays(i.form_582_due, -30);
  const event = ctx.events.append({ type: "supplement_attestation.signed", occurredAt: `${i.signed_on}T17:00:00.000Z`, aggregate: PROGRAM_AGGREGATE, actor: ctx.actor, payload: { attestation_id: i.attestation_id, period: i.period, document_id: i.document_id, template_code: "NTC_SUPPLEMENT_ATTESTATION", signed_on: i.signed_on, signed_by: `${ctx.actor.kind}:${ctx.actor.id}`, sent_by_role: "officer", form_582_due: i.form_582_due, attestation_due: due, days_before_form582_due: daysBetween(i.signed_on, i.form_582_due), assessor: i.assessor, assessment_completed_on: i.assessment_completed_on, pen_test_completed_on: i.pen_test_completed_on, exceptions_open: i.exceptions_open, exceptions_summary: i.exceptions_summary ?? "", delivered_to: "partner" } });
  return { event, attestation_due: due, on_time: i.signed_on <= due };
}
/** `nydfs_certification.filed` (NYDFS_500_17B_ANNUAL_CERT_APR15): the April 15 submission — the kind is what the control results dictate (rule 11: any unexcepted `fail` forces an acknowledgment), signed by the highest-ranking executive and the CISO, filed by an officer. */
export function fileNydfsCertification(ctx: SecurityOpsContext, i: { controls: readonly NydfsControlRow[]; as_of: PlainDate; signers: { ceo_name: string; ceo_title: string; ciso_name: string; entity_name: string }; filed_on: PlainDate; filing_document_id: string; asserted_kind?: "certification" | "acknowledgment_of_noncompliance" }): { event: DomainEvent; package: NydfsAnnualPackage; late: boolean } {
  need(i.as_of, "as_of"); need(i.filed_on, "filed_on"); need(i.filing_document_id, "filing_document_id"); need(i.signers?.ceo_name, "signers.ceo_name"); need(i.signers?.ciso_name, "signers.ciso_name");
  requireRole(ctx.actor, ["officer"], "NYDFS_FILING_OFFICER", "19.2 escalations: NYDFS portal submissions are officer tasks (portal submissions carry certifications)", "the 500.17(b) filing");
  const pkg = nydfsAnnualPackage(i.controls, i.as_of, i.signers);
  refuseUnless(i.asserted_kind === undefined || i.asserted_kind === pkg.kind, "NYDFS_CERT_FORCED", "19.2 rule 11: any `fail` without an approved exception at the reporting date forces an acknowledgment of noncompliance (NYDFS) rather than a certification", `${i.asserted_kind} asserted but the control results dictate ${pkg.kind} (${pkg.deficient_controls.join(", ") || "no deficiencies"})`);
  const late = i.filed_on > pkg.filing_deadline;
  const event = ctx.events.append({ type: "nydfs_certification.filed", occurredAt: `${i.filed_on}T17:00:00.000Z`, aggregate: PROGRAM_AGGREGATE, actor: ctx.actor, payload: { kind: pkg.kind, year: pkg.payload.year, filing_deadline: pkg.filing_deadline, filed_on: i.filed_on, late, deficient_controls: [...pkg.deficient_controls], deficient_sections: [...pkg.deficient_sections], signed_by: [`${i.signers.ceo_name} (${i.signers.ceo_title})`, `${i.signers.ciso_name} (CISO)`], filed_by: `${ctx.actor.kind}:${ctx.actor.id}`, filing_document_id: i.filing_document_id, template_code: "NTC_NYDFS_ANNUAL_CERT", records_retention: "nydfs_500_17b_cert_support_5y" } });
  return { event, package: pkg, late };
}
export const ACCESS_REVIEW_SCOPES: readonly string[] = ["all", "privileged", "fl_restricted", "fnma_credentials"];
/** `access_review.completed{scope}`: the entitlement owner's / user manager's certification — annual for all human and system accounts (FNMA_SUPP_ACCESS_CERT_365), quarterly for privileged accounts (SM_PRIV_ACCESS_REVIEW_90); the `access_reviews` row. */
export function completeAccessReview(ctx: SecurityOpsContext, i: { review_id: string; scope: string; period: string; opened_at: string; reviewer: string; identities_reviewed: number; changes: readonly unknown[]; completed_on?: PlainDate }): { event: DomainEvent; row: Record<string, unknown> } {
  need(i.review_id, "review_id"); need(i.scope, "scope"); need(i.period, "period"); need(i.reviewer, "reviewer");
  refuseUnless(ACCESS_REVIEW_SCOPES.includes(i.scope), "ACCESS_REVIEW_SCOPE", "19.2 data model: access_reviews.scope ∈ {all, privileged, fl_restricted, fnma_credentials}", `scope ${i.scope}`);
  refuseUnless(Number.isInteger(i.identities_reviewed) && i.identities_reviewed > 0, "ACCESS_REVIEW_EMPTY", "Fannie Mae Supplement: access reviewed and certified by the entitlement owner or user manager", "no identities reviewed");
  const completedOn = i.completed_on ?? civil(ctx.now);
  const row = { id: i.review_id, scope: i.scope, period: i.period, opened_at: i.opened_at, completed_at: `${completedOn}T17:00:00.000Z`, reviewer: i.reviewer, changes: [...i.changes] };
  const event = ctx.events.append({ type: "access_review.completed", occurredAt: row.completed_at, aggregate: PROGRAM_AGGREGATE, actor: ctx.actor, payload: { ...row, completed_on: completedOn, identities_reviewed: i.identities_reviewed, certified_by: i.reviewer } });
  return { event, row };
}
/** `personnel.training.completed{course=security_awareness}` (FNMA_SUPP_TRAINING_365): annual security-awareness training covering data retention, per person; new hires within 30 days (policy). */
export function completeSecurityTraining(ctx: SecurityOpsContext, i: { identity_id: string; course: string; completed_on: PlainDate; covers_data_retention: boolean; hire_date?: PlainDate | null; document_id?: string | null }): { event: DomainEvent; next_due_on: PlainDate; new_hire_due_on: PlainDate | null; within_new_hire_window: boolean | null } {
  need(i.identity_id, "identity_id"); need(i.course, "course"); need(i.completed_on, "completed_on");
  refuseUnless(i.course === "security_awareness", "TRAINING_COURSE", "Fannie Mae Supplement: annual security-awareness training", `${i.course} is not the security-awareness course`);
  refuseUnless(i.covers_data_retention, "TRAINING_CONTENT", "Fannie Mae Supplement: security-awareness training covering data retention", "the course does not cover data retention");
  const newHireDue = i.hire_date ? addDays(i.hire_date, 30) : null;
  const event = ctx.events.append({ type: "personnel.training.completed", occurredAt: `${i.completed_on}T17:00:00.000Z`, aggregate: { kind: "identity", id: i.identity_id }, actor: ctx.actor, payload: { identity_id: i.identity_id, course: i.course, covers_data_retention: true, completed_on: i.completed_on, hire_date: i.hire_date ?? null, new_hire_due_on: newHireDue, next_due_on: addDays(i.completed_on, 365), document_id: i.document_id ?? null } });
  return { event, next_due_on: addDays(i.completed_on, 365), new_hire_due_on: newHireDue, within_new_hire_window: newHireDue ? i.completed_on <= newHireDue : null };
}
/** `bcp_exercise.completed` (FNMA_SUPP_BCP_TEST_365; NYDFS 500.16(c)): the annual tabletop or DR failover, tested with the critical staff, with the Fannie Mae crisis contacts in the plan. */
export function completeBcpExercise(ctx: SecurityOpsContext, i: { exercise_id: string; kind: "tabletop" | "dr_failover"; completed_on: PlainDate; document_id: string; critical_staff_participated: boolean; fannie_mae_contacts_in_plan: boolean; findings?: readonly unknown[] }): { event: DomainEvent; next_due_on: PlainDate } {
  need(i.exercise_id, "exercise_id"); need(i.kind, "kind"); need(i.completed_on, "completed_on"); need(i.document_id, "document_id");
  refuseUnless(i.kind === "tabletop" || i.kind === "dr_failover", "BCP_EXERCISE_KIND", "19.2 timer table: annual tabletop + DR failover", `kind ${i.kind}`);
  refuseUnless(i.critical_staff_participated, "BCP_CRITICAL_STAFF", "23 NYCRR 500.16(d): BCDR plan tested at least annually with all staff and management critical to the response", "critical staff did not participate");
  refuseUnless(i.fannie_mae_contacts_in_plan, "BCP_FNMA_CONTACTS", "Fannie Mae Supplement: crisis communications naming Fannie Mae contacts", "the plan names no Fannie Mae contacts");
  const event = ctx.events.append({ type: "bcp_exercise.completed", occurredAt: `${i.completed_on}T17:00:00.000Z`, aggregate: PROGRAM_AGGREGATE, actor: ctx.actor, payload: { exercise_id: i.exercise_id, kind: i.kind, completed_on: i.completed_on, document_id: i.document_id, critical_staff_participated: true, fannie_mae_contacts_in_plan: true, findings: [...(i.findings ?? [])], next_due_on: addDays(i.completed_on, 365) } });
  return { event, next_due_on: addDays(i.completed_on, 365) };
}
/** The restore test as the platform records it: `backup_restore_test.passed` (runs NYDFS_500_16D_BACKUP_RESTORE_TEST_365 from the last pass) or `backup_restore_test.failed` (a `fail` control result, sev-1, BCP exception logged — 19.2-T13). */
export function recordBackupRestoreTest(ctx: SecurityOpsContext, i: RestoreTestInput): RestoreTest & { readonly appended: DomainEvent } {
  const r = backupRestoreTest(i);
  const appended = ctx.events.append({ type: r.event.type, occurredAt: r.event.occurredAt, aggregate: r.event.aggregate, actor: ctx.actor, payload: r.event.payload });
  return { ...r, appended };
}
/** `firewall_rule_review.completed` (FNMA_SUPP_FIREWALL_RULE_REVIEW_90): the quarterly firewall / security-group rule review on the defined frequency. */
export function completeFirewallRuleReview(ctx: SecurityOpsContext, i: { review_id: string; period: string; reviewer: string; rules_reviewed: number; changes: readonly unknown[]; completed_on: PlainDate; document_id?: string | null }): { event: DomainEvent } {
  need(i.review_id, "review_id"); need(i.period, "period"); need(i.reviewer, "reviewer"); need(i.completed_on, "completed_on");
  refuseUnless(Number.isInteger(i.rules_reviewed) && i.rules_reviewed > 0, "FIREWALL_REVIEW_EMPTY", "Fannie Mae Supplement: firewall-rule reviews on a defined frequency", "no rules reviewed");
  return { event: ctx.events.append({ type: "firewall_rule_review.completed", occurredAt: `${i.completed_on}T17:00:00.000Z`, aggregate: PROGRAM_AGGREGATE, actor: ctx.actor, payload: { review_id: i.review_id, period: i.period, reviewer: i.reviewer, rules_reviewed: i.rules_reviewed, changes: [...i.changes], completed_on: i.completed_on, document_id: i.document_id ?? null } }) };
}
/** `wireless_review.completed` (FNMA_SUPP_WIRELESS_REVIEW_365): the annual wireless review. */
export function completeWirelessReview(ctx: SecurityOpsContext, i: { review_id: string; reviewer: string; networks_reviewed: number; completed_on: PlainDate; findings?: readonly unknown[]; document_id?: string | null }): { event: DomainEvent; next_due_on: PlainDate } {
  need(i.review_id, "review_id"); need(i.reviewer, "reviewer"); need(i.completed_on, "completed_on");
  refuseUnless(Number.isInteger(i.networks_reviewed) && i.networks_reviewed >= 0, "WIRELESS_REVIEW_COUNT", "Fannie Mae Supplement: annual wireless reviews", "networks_reviewed must be a non-negative integer");
  return { event: ctx.events.append({ type: "wireless_review.completed", occurredAt: `${i.completed_on}T17:00:00.000Z`, aggregate: PROGRAM_AGGREGATE, actor: ctx.actor, payload: { review_id: i.review_id, reviewer: i.reviewer, networks_reviewed: i.networks_reviewed, completed_on: i.completed_on, findings: [...(i.findings ?? [])], document_id: i.document_id ?? null, next_due_on: addDays(i.completed_on, 365) } }), next_due_on: addDays(i.completed_on, 365) };
}
/** `control_exceptions.approved{control}` (NYDFS_500_12_MFA_COMPENSATING_REVIEW_365 trigger for CTL-SEC-01): only the Qualified Individual approves, with expiry ≤ 12 months and an annual review date. */
export function approveControlException(ctx: SecurityOpsContext, i: { exception_id: string; control_code: string; scope: string; justification: string; compensating_controls: string; approved_on: PlainDate; expires_on: PlainDate; vulnerability_id?: string | null }): { event: DomainEvent; review_due_on: PlainDate } {
  need(i.exception_id, "exception_id"); need(i.control_code, "control_code"); need(i.justification, "justification"); need(i.compensating_controls, "compensating_controls"); need(i.approved_on, "approved_on"); need(i.expires_on, "expires_on");
  requireRole(ctx.actor, ["ciso"], "EXCEPTION_QI_APPROVAL", "19.2 rule 6 / tools: exceptions approved by the Qualified Individual (exceptions.propose — no approve)", "approving a control exception");
  refuseUnless(i.expires_on <= addDays(i.approved_on, 366) && i.expires_on > i.approved_on, "EXCEPTION_EXPIRY", "19.2 rule 6: exceptions approved by the Qualified Individual with expiry ≤ 12 months", `expiry ${i.expires_on} is not within 12 months of ${i.approved_on}`);
  const reviewDue = addDays(i.approved_on, 365) < i.expires_on ? addDays(i.approved_on, 365) : i.expires_on;
  const event = ctx.events.append({ type: "control_exceptions.approved", occurredAt: `${i.approved_on}T17:00:00.000Z`, aggregate: { kind: "control_exception", id: i.exception_id }, actor: ctx.actor, payload: { exception_id: i.exception_id, control: i.control_code, control_code: i.control_code, scope: i.scope, justification: i.justification, compensating_controls: i.compensating_controls, approved_by: `${ctx.actor.kind}:${ctx.actor.id}`, approved_at: `${i.approved_on}T17:00:00.000Z`, expires_at: i.expires_on, review_due_at: reviewDue, vulnerability_id: i.vulnerability_id ?? null } });
  return { event, review_due_on: reviewDue };
}
/** `control_exception.reviewed{control}` (NYDFS 500.12(b): compensating controls reviewed by the CISO at least annually): `continue` re-arms the annual review; `expire` ends the exception. */
export function reviewControlException(ctx: SecurityOpsContext, i: { exception_id: string; control_code: string; reviewed_on: PlainDate; outcome: "continue" | "expire"; rationale: string }): { event: DomainEvent } {
  need(i.exception_id, "exception_id"); need(i.control_code, "control_code"); need(i.reviewed_on, "reviewed_on"); need(i.rationale, "rationale");
  requireRole(ctx.actor, ["ciso"], "EXCEPTION_REVIEW_CISO", "23 NYCRR 500.12(b): compensating controls approved and reviewed at least annually by the CISO", "reviewing a control exception");
  refuseUnless(i.outcome === "continue" || i.outcome === "expire", "EXCEPTION_REVIEW_OUTCOME", "19.2 timer table: review; exception expires", `outcome ${i.outcome}`);
  return { event: ctx.events.append({ type: "control_exception.reviewed", occurredAt: `${i.reviewed_on}T17:00:00.000Z`, aggregate: { kind: "control_exception", id: i.exception_id }, actor: ctx.actor, payload: { exception_id: i.exception_id, control: i.control_code, control_code: i.control_code, reviewed_on: i.reviewed_on, outcome: i.outcome, rationale: i.rationale, reviewed_by: `${ctx.actor.kind}:${ctx.actor.id}` } }) };
}
/** Weekly scan ingestion (CTL-SEC-04): every new finding is a `vulnerability.detected` with its computed `remediation_due` (arms SM_VULN_REMEDIATION_SLA); every verified fix is a `vulnerability.remediated{disposition=remediated}` (closes it). */
export function ingestVulnerabilityScan(ctx: SecurityOpsContext, i: { scan_id: string; source: string; findings: readonly VulnerabilityInput[]; remediated?: readonly { vulnerability_id: string; remediated_at: string; verified_by_scan_id: string }[] }): { detected: readonly (ReturnType<typeof vulnerabilityDetected> & { appended: DomainEvent })[]; remediated: readonly DomainEvent[] } {
  need(i.scan_id, "scan_id"); need(i.source, "source");
  const detected = i.findings.map((f) => { need(f.vulnerability_id, "vulnerability_id"); need(f.asset_id, "asset_id"); const v = vulnerabilityDetected(f); return { ...v, appended: ctx.events.append({ type: v.event.type, occurredAt: v.event.occurredAt, aggregate: v.event.aggregate, actor: ctx.actor, payload: { ...v.event.payload, source: i.source, scan_id: i.scan_id } }) }; });
  const remediated = (i.remediated ?? []).map((r) => { need(r.vulnerability_id, "vulnerability_id"); need(r.verified_by_scan_id, "verified_by_scan_id"); return ctx.events.append({ type: "vulnerability.remediated", occurredAt: r.remediated_at, aggregate: { kind: "vulnerability", id: r.vulnerability_id }, actor: ctx.actor, payload: { vulnerability_id: r.vulnerability_id, remediated_at: r.remediated_at, disposition: "remediated", verified_by_scan_id: r.verified_by_scan_id, scan_id: i.scan_id } }); });
  return { detected, remediated };
}
/** The SLA row's second satisfier — "or approved exception": a Qualified-Individual-approved exception closes the vulnerability's SLA (`vulnerability.remediated{disposition=approved_exception}` on the `vulnerabilities.exception_id` link). */
export function exceptVulnerability(ctx: SecurityOpsContext, i: { vulnerability_id: string; exception_id: string; approval: DomainEvent | null }): { event: DomainEvent } {
  need(i.vulnerability_id, "vulnerability_id"); need(i.exception_id, "exception_id");
  refuseUnless(!!i.approval && i.approval.type === "control_exceptions.approved" && i.approval.payload.exception_id === i.exception_id && i.approval.actor.kind === "human" && i.approval.actor.role === "ciso", "VULN_EXCEPTION_UNAPPROVED", "19.2 rule 6: exceptions approved by the Qualified Individual with expiry ≤ 12 months", `no Qualified Individual approval on the log for exception ${i.exception_id}`);
  return { event: ctx.events.append({ type: "vulnerability.remediated", aggregate: { kind: "vulnerability", id: i.vulnerability_id }, actor: ctx.actor, payload: { vulnerability_id: i.vulnerability_id, remediated_at: null, disposition: "approved_exception", exception_id: i.exception_id, expires_at: i.approval!.payload.expires_at ?? null } }) };
}
/** `identity.credential.reset{fnma_credentials, kind, reset_at, reset_due}`: the vault/IdP rotation with the computed anchor the FNMA_TECHGUIDE_CREDENTIAL_RESET_90D row reads — 90 calendar days for a human Fannie Mae credential, 365 for a Fannie Mae System ID (Technology Guide). */
export function credentialReset(ctx: SecurityOpsContext, i: { secret_id: string; kind: string; fnma_credentials: boolean; reset_at?: string; version?: number }): { event: DomainEvent; reset_due: PlainDate | null; period_days: 90 | 365 | null } {
  need(i.secret_id, "secret_id");
  const resetAt = i.reset_at ?? ctx.now;
  const clock = i.fnma_credentials ? credentialResetClock(i.kind === "fnma_system_id" ? "fnma_system_id" : "human", civil(resetAt), civil(resetAt)) : null;
  const event = ctx.events.append({ type: "identity.credential.reset", occurredAt: resetAt, aggregate: { kind: "secret", id: i.secret_id }, actor: ctx.actor, payload: { secret_id: i.secret_id, kind: i.kind, fnma_credentials: i.fnma_credentials, reset_at: resetAt, reset_due: clock?.due ?? null, period_days: clock?.period_days ?? null, version: i.version ?? null, reversible: true } });
  return { event, reset_due: clock?.due ?? null, period_days: clock?.period_days ?? null };
}
export interface CredentialRow { readonly id: string; readonly kind: "human" | "system" | "fnma_system_id" | "vendor"; readonly fnma_credentials: boolean; readonly last_credential_reset_at: string | null; readonly disabled_at?: string | null; }
/** CTL-SEC-02 (daily credential-age control): every Fannie Mae credential past its 90/365-day reset is auto-disabled (`identity.disabled{auto=true}`) with a sev-1 (19.2-T11; rule 5 "auto-disable on breach"). */
export function credentialAgeControlTest(ctx: SecurityOpsContext, identities: readonly CredentialRow[], today: PlainDate = civil(ctx.now)): ControlResult & { readonly disabled: readonly { identity_id: string; kind: string; due: PlainDate; event: DomainEvent }[]; readonly next_due: readonly { identity_id: string; due: PlainDate }[] } {
  const disabled: { identity_id: string; kind: string; due: PlainDate; event: DomainEvent }[] = []; const nextDue: { identity_id: string; due: PlainDate }[] = []; const findings: string[] = [];
  for (const id of identities.filter((x) => x.fnma_credentials && !x.disabled_at)) {
    if (!id.last_credential_reset_at) { findings.push(`${id.id}: no credential reset on record`); continue; }
    const c = credentialResetClock(id.kind === "fnma_system_id" ? "fnma_system_id" : "human", civil(id.last_credential_reset_at), today);
    nextDue.push({ identity_id: id.id, due: c.due });
    if (!c.disabled_on) continue;
    findings.push(`${id.id}: ${c.escalation!.reason}`);
    disabled.push({ identity_id: id.id, kind: id.kind, due: c.due, event: ctx.events.append({ type: "identity.disabled", aggregate: { kind: "identity", id: id.id }, actor: ctx.actor, payload: { identity_id: id.id, incident_id: null, auto: true, code: c.timer_code, due: c.due, reason: c.action!.reason, reversible: true } }) });
  }
  return { control: "CTL-SEC-02", result: findings.length === 0 ? "pass" : "fail", findings, actions: disabled.map((d) => ({ action: "idp.disableIdentity", target: d.identity_id, by_ms: Date.parse(ctx.now) })), board_report_items: disabled.map((d) => `CTL-SEC-02 fail: ${d.identity_id} credential reset overdue (auto-disabled)`), escalation: disabled.length ? { kind: "sev1", owner_role: "ciso", reason: `${disabled.length} Fannie Mae credential(s) past the reset window auto-disabled (Technology Guide)` } : null, disabled, next_due: nextDue };
}
