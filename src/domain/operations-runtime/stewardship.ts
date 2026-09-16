/**
 * §35.11 — the ops steward (spec/sections/35-operations-runtime/35-11-operations-stewardship-and-hosted-measurement.md).
 * The `qc-audit` agent's pass over 35.3's registry, 35.1's outbox and sweep runs, the breach escalations and the FAKE reviewers:
 * it reads, opens, classifies, assigns and reports, and completes nothing a clock or a section opened (rule 1,
 * NEVER_COMPLETES_A_BREACH). Every state change is an `ops_exceptions` row, an `exception_triages` row, an `agent_decisions`
 * row and one of the events below — each event type a string literal here so tools/lint-emission.ts counts it:
 *   ops.cycle.missed / ops.cycle.recovered            rule 2 — a registry finding, resolved by the cycle's receipt
 *   ops.exception.opened / .classified / .triaged     rules 2–3 — SM_OPS_EXCEPTION_TRIAGE_1BD arms on opened, satisfied by triaged;
 *   ops.exception.assigned / .resolved                  SM_OPS_ADAPTER_DOWN_1H arms on classified{kind = adapter_down}, satisfied by resolved
 *   ops.fake_in_production, ops.report.run_completed  rules 5–7 (report.ts assembles the row; the literals live here)
 *   outbox.requeued{…, by: "agent:qc-audit", by_role: null, auto: true, reason}   rule 4 — 34.4's literal, the bounded automatic requeue
 * Every act runs inside one unit of work (a bus command's, or the pass's own global one): the exception row is written on the
 * transaction, the events ride ctx.events, the triage row and the escalation link are deferred to the commit (after the events
 * and the decision they reference exist), so a refusal writes nothing. This file contains no call to any escalation completion
 * or timer write (T8's contract).
 */
import { randomUUID } from "node:crypto";
import type { Actor, DomainEvent, EventInput } from "../../kernel/events/index.ts";
import type { Clock } from "../../kernel/events/index.ts";
import type { Queryable } from "../../infra/db/client.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import type { Runtime } from "../../runtime/app.ts";
import { EscalationService, type EscalationKind } from "../../app/escalations.ts";
import { StaffError } from "../../runtime/staff/roles.ts";
import { resetForRequeue } from "../../runtime/controls/outbox.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { classifyBySource, classifyDeadMessage, messageSignals, type Classification, type Signals } from "./stewardship-35-11/classify.ts";
import { feedsOf, portsOf, type Feeds, type StewardPorts } from "./stewardship-35-11/ports.ts";
import { AUTO_REQUEUE_CAP, CONFIDENCE_FLOOR, ET, EXCEPTION_COLS, LIVE_STATUSES, OPS_RULE_SET_VERSION, PROCESS_35_11, REPORT_AT_ET, STEWARD_ACTOR, STEWARD_AGENT, STEWARD_MODEL_VERSION, STEWARD_PROMPT_VERSION, byOf, isProduction, isUuid, s, type ExceptionKind, type ExceptionRow, type ExceptionStatus, type Row, type SourceKind, type TriageAction } from "./stewardship-35-11/types.ts";
import { runDailyReport, reportRanOn, type DailyReportResult } from "./stewardship-35-11/report.ts";
import { runbookForCycle, runbookForTimer } from "./stewardship-35-11/runbook.ts";

// ---------------------------------------------------------------- the events (string literals: tools/lint-emission.ts)
export const EV = {
  cycleMissed: "ops.cycle.missed", cycleRecovered: "ops.cycle.recovered",
  opened: "ops.exception.opened", classified: "ops.exception.classified", triaged: "ops.exception.triaged", assigned: "ops.exception.assigned", resolved: "ops.exception.resolved",
  fakeInProduction: "ops.fake_in_production", reportCompleted: "ops.report.run_completed",
  requeued: "outbox.requeued",
} as const;
export const CYCLE_MISSED_CODE = "SM_OPS_CYCLE_MISSED_2H";
export const ADAPTER_DOWN_CODE = "SM_OPS_ADAPTER_DOWN_1H";
export const STALLED_RUN_CODE = "SM_CYCLE_RUN_STALLED_1D";

/** A typed refusal of an act (AUTO_REQUEUE_CAP_1, CONFIDENCE_FLOOR_0_85, UNKNOWN_CODE, NO_SUCH_EXCEPTION, …): 409/404 with the code, in 34.4's StaffError shape. */
export class StewardRefused extends StaffError {
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) { super(status, code, message, extra); this.name = "StewardRefused"; }
}

export interface StewardDeps {
  readonly q: Queryable;
  readonly events: { append(e: EventInput): DomainEvent };
  readonly clock: Clock; readonly now: string; readonly actor: Actor;
  readonly escalations: EscalationService;
  readonly decide: (d: DecisionInput) => void;
  /** A row written in the same transaction after the events and the decisions (a triage row references both). */
  readonly deferWrite: (fn: (q: Queryable) => Promise<void>) => void;
  readonly environment: string;
  readonly ports: Required<StewardPorts>;
  readonly runtime?: Runtime;
}

const decision = (d: StewardDeps, i: { subject: { kind: string; id: string }; action: string; kind?: string | null; confidence: number; signals?: Signals | Row | null; rationale: string; eventId?: string | undefined }): void =>
  d.decide({ agent: STEWARD_AGENT, action: i.action, rationale: `${i.rationale}${i.kind ? ` [kind: ${i.kind}]` : ""}${i.signals ? ` signals ${JSON.stringify(i.signals)}` : ""} (rule_set_version: ${OPS_RULE_SET_VERSION}, model_version: ${STEWARD_MODEL_VERSION}, prompt_version: ${STEWARD_PROMPT_VERSION})`, ruleSetVersion: OPS_RULE_SET_VERSION, subject: i.subject, confidence: i.confidence, modelVersion: STEWARD_MODEL_VERSION, promptVersion: STEWARD_PROMPT_VERSION, ...(i.eventId ? { eventId: i.eventId } : {}) });

/** The triage row, written at commit: the decision of this act (persisted before the commit hook) and the event it logged. */
function triage(d: StewardDeps, i: { exception_id: string; action: TriageAction; kind?: string | null; confidence?: number | null; signals?: Row; assigned_role?: string | null; reason?: string | null; event_id?: string | null; decision_action?: string }): string {
  const id = randomUUID();
  d.deferWrite(async (q) => {
    const dec = i.decision_action ? (await q.query<{ id: string }>(`SELECT id::text AS id FROM agent_decisions WHERE agent = $1 AND subject_id = $2 AND action = $3 ORDER BY created_at DESC, id DESC LIMIT 1`, [STEWARD_AGENT, i.exception_id, i.decision_action]))[0]?.id ?? null : null;
    await q.query(`INSERT INTO exception_triages (id, exception_id, action, kind, confidence, signals, actor_kind, actor_id, actor_role, assigned_role, reason, decision_id, event_id, created_at) VALUES ($1, $2::uuid, $3, $4, $5, $6::jsonb, $7::actor_kind, $8, $9, $10, $11, $12::uuid, $13::uuid, $14::timestamptz)`,
      [id, i.exception_id, i.action, i.kind ?? null, i.confidence ?? null, JSON.stringify(i.signals ?? {}), d.actor.kind, d.actor.id, d.actor.role ?? null, i.assigned_role ?? null, i.reason ?? null, dec, i.event_id ?? null, d.now]);
    await q.query(`UPDATE ops_exceptions SET latest_triage_id = $2::uuid WHERE id = $1::uuid`, [i.exception_id, id]);
  });
  return id;
}
const agg = (id: string) => ({ kind: "ops_exception", id });
const roleOf = (a: Actor): string | null => a.role ?? null;

export async function exceptionById(q: Queryable, id: string): Promise<ExceptionRow | null> {
  if (!isUuid(id)) throw new StewardRefused(400, "BAD_REQUEST", "exception_id is a uuid");
  return (await q.query<ExceptionRow>(`SELECT ${EXCEPTION_COLS} FROM ops_exceptions WHERE id = $1::uuid`, [id]))[0] ?? null;
}
export async function liveException(q: Queryable, source_kind: SourceKind, source_id: string): Promise<ExceptionRow | null> {
  return (await q.query<ExceptionRow>(`SELECT ${EXCEPTION_COLS} FROM ops_exceptions WHERE source_kind = $1 AND source_id = $2 AND status = ANY($3::text[]) ORDER BY opened_at DESC LIMIT 1`, [source_kind, source_id, [...LIVE_STATUSES]]))[0] ?? null;
}
const requireLive = async (d: StewardDeps, id: string): Promise<ExceptionRow> => {
  const row = await exceptionById(d.q, id);
  if (!row) throw new StewardRefused(404, "NO_SUCH_EXCEPTION", `no exception ${id}`);
  if (!LIVE_STATUSES.includes(row.status)) throw new StewardRefused(409, "EXCEPTION_TERMINAL", `exception ${id} is ${row.status}`, { status: row.status });
  return row;
};
/** `ops.exception.triaged` on the first of classify, assign or requeue (the exception was `open`). */
function triagedIfFirst(d: StewardDeps, row: ExceptionRow, action: string): DomainEvent | null {
  if (row.status !== "open") return null;
  return d.events.append({ type: EV.triaged, aggregate: agg(row.id), actor: d.actor, payload: { exception_id: row.id, action, by: byOf(d.actor), by_role: roleOf(d.actor), environment: row.environment } });
}

// ---------------------------------------------------------------- open
export interface OpenInput { readonly source_kind: SourceKind; readonly source_id: string; readonly adapter?: string | null; readonly loan_id?: string | null; readonly application_id?: string | null; readonly kind?: ExceptionKind; readonly owner_role?: string; readonly signals?: Row; readonly source_event_id?: string | null; readonly environment?: string }
export interface OpenResult { readonly exception_id: string; readonly created: boolean; readonly row: ExceptionRow }
/** Rule 2/3: one live exception per source — a second opening of the same (source_kind, source_id) adds nothing (the partial unique index). */
export async function openException(d: StewardDeps, i: OpenInput): Promise<OpenResult> {
  const live = await liveException(d.q, i.source_kind, i.source_id);
  if (live) return { exception_id: live.id, created: false, row: live };
  const id = randomUUID(); const environment = i.environment ?? d.environment;
  const [row] = await d.q.query<ExceptionRow>(`INSERT INTO ops_exceptions (id, environment, source_kind, source_id, adapter, loan_id, application_id, kind, status, owner_role, opened_at, created_at) VALUES ($1, $2, $3, $4, $5, $6::uuid, $7::uuid, $8, 'open', $9, $10::timestamptz, $10::timestamptz) RETURNING ${EXCEPTION_COLS}`,
    [id, environment, i.source_kind, i.source_id, i.adapter ?? null, isUuid(i.loan_id) ? i.loan_id : null, isUuid(i.application_id) ? i.application_id : null, i.kind ?? "unclassified", i.owner_role ?? "ops_analyst", d.now]);
  const ev = d.events.append({ type: EV.opened, aggregate: agg(id), actor: d.actor, payload: { exception_id: id, environment, source_kind: i.source_kind, source_id: i.source_id, adapter: i.adapter ?? null, opened_at: d.now, kind: i.kind ?? "unclassified" } });
  decision(d, { subject: { kind: "ops_exception", id }, action: "ops.exceptions.open", kind: i.kind ?? null, confidence: 1, rationale: `opened ${i.source_kind} ${i.source_id}${i.adapter ? ` (${i.adapter})` : ""} in ${environment}`, eventId: ev.id });
  triage(d, { exception_id: id, action: "opened", kind: i.kind ?? "unclassified", signals: { ...(i.signals ?? {}), ...(i.source_event_id ? { source_event_id: i.source_event_id } : {}) }, event_id: ev.id, decision_action: "ops.exceptions.open" });
  return { exception_id: id, created: true, row: row! };
}

// ---------------------------------------------------------------- classify (rule 3) and its rule-4 follow-up
export interface ClassifyResult { readonly exception_id: string; readonly kind: ExceptionKind; readonly confidence: number; readonly signals: Signals; readonly changed: boolean; readonly follow_up: "requeued" | "proposed" | "assigned" | "waiting" | "none"; readonly refusal: { code: string; reason: string } | null }
export async function classifyException(d: StewardDeps, i: { exception_id: string; follow_up?: boolean }): Promise<ClassifyResult> {
  const row = await requireLive(d, i.exception_id);
  let c: Classification;
  if (row.source_kind === "integration_message") c = classifyDeadMessage(await messageSignals(d.q, { message_id: row.source_id, adapter: row.adapter ?? "", now: d.now }));
  else { const bs = classifyBySource(row.source_kind, row.kind); if (!bs) throw new StewardRefused(409, "UNCLASSIFIABLE", `a ${row.source_kind} exception has no classification rule`); c = bs; }
  const changed = row.kind !== c.kind || row.classified_at === null || Number(row.confidence ?? 0) !== c.confidence;
  const triagedEv = triagedIfFirst(d, row, "classify");
  let classifiedEv: DomainEvent | null = null;
  if (changed) {
    await d.q.query(`UPDATE ops_exceptions SET kind = $2, confidence = $3, classified_at = $4::timestamptz, status = CASE WHEN status = 'open' THEN 'triaged' ELSE status END WHERE id = $1::uuid`, [row.id, c.kind, c.confidence, d.now]);
    classifiedEv = d.events.append({ type: EV.classified, aggregate: agg(row.id), actor: d.actor, payload: { exception_id: row.id, kind: c.kind, confidence: c.confidence, classified_at: d.now, rule_set_version: OPS_RULE_SET_VERSION, adapter: row.adapter, source_kind: row.source_kind, source_id: row.source_id, environment: row.environment, signals: c.signals } });
  } else if (row.status === "open") await d.q.query(`UPDATE ops_exceptions SET status = 'triaged' WHERE id = $1::uuid`, [row.id]);
  decision(d, { subject: { kind: "ops_exception", id: row.id }, action: "ops.exceptions.classify", kind: c.kind, confidence: c.confidence, signals: c.signals, rationale: `${c.rule} → ${c.kind} (${c.confidence})${changed ? "" : "; unchanged"}`, eventId: classifiedEv?.id ?? triagedEv?.id });
  triage(d, { exception_id: row.id, action: "classified", kind: c.kind, confidence: c.confidence, signals: c.signals, reason: c.rule, event_id: classifiedEv?.id ?? triagedEv?.id ?? null, decision_action: "ops.exceptions.classify" });
  const after: ExceptionRow = { ...row, kind: c.kind, confidence: String(c.confidence), classified_at: d.now, status: row.status === "open" ? "triaged" : row.status };
  if (i.follow_up === false) return { exception_id: row.id, kind: c.kind, confidence: c.confidence, signals: c.signals, changed, follow_up: "none", refusal: null };
  // rule 4: transient ≥ 0.85 → the one automatic requeue at once; poison / needs_person → proposed and assigned; adapter_down → the pass waits for a success; the registry kinds are assigned by their own steps
  if (row.source_kind === "integration_message") {
    if (c.kind === "transient" && c.confidence >= CONFIDENCE_FLOOR) { const r = await requeueAuto(d, after, "transient"); return { exception_id: row.id, kind: c.kind, confidence: c.confidence, signals: c.signals, changed, follow_up: r.ok ? "requeued" : "assigned", refusal: r.ok ? null : { code: r.code, reason: r.reason } }; }
    if (c.kind === "poison" || c.kind === "needs_person" || (c.kind === "transient" && c.confidence < CONFIDENCE_FLOOR)) { await requeuePropose(d, after, `${c.kind} at ${c.confidence}: ${c.kind === "transient" ? "below the confidence floor" : "never requeued by the agent"} (rule 4)`); return { exception_id: row.id, kind: c.kind, confidence: c.confidence, signals: c.signals, changed, follow_up: "proposed", refusal: null }; }
  }
  return { exception_id: row.id, kind: c.kind, confidence: c.confidence, signals: c.signals, changed, follow_up: "waiting", refusal: null };
}

// ---------------------------------------------------------------- requeue (rule 4)
export interface RequeueOutcome { readonly ok: boolean; readonly code: string; readonly reason: string; readonly requeue_no?: number }
/** The bounded automatic requeue: kind transient ≥ 0.85, or adapter_down once the adapter has a success after classified_at; once per message (AUTO_REQUEUE_CAP_1). Refusals are answers, never a throw: the pass assigns instead. */
export async function requeueAuto(d: StewardDeps, row: ExceptionRow, why: "transient" | "adapter_recovered" | "manual"): Promise<RequeueOutcome> {
  if (row.source_kind !== "integration_message") return { ok: false, code: "NOT_A_MESSAGE", reason: `a ${row.source_kind} exception has no message to requeue` };
  const conf = Number(row.confidence ?? 0);
  if (row.auto_requeues >= AUTO_REQUEUE_CAP) {
    // the pass assigns the exception to a person instead; a hand call of `op: auto` is refused without a write (a refusal never follows a write in the same command)
    if (why !== "manual" && row.status !== "assigned") await assignException(d, { exception_id: row.id, role: "ops_analyst", reason: `AUTO_REQUEUE_CAP_1: message ${row.source_id} was already requeued ${row.auto_requeues} time(s) automatically; a person's hand requeue is the only path (34.4)` }, row);
    return { ok: false, code: "AUTO_REQUEUE_CAP_1", reason: `message ${row.source_id} was already requeued automatically (auto_requeues = ${row.auto_requeues}); the exception is a person's (ops_analyst) and the hand requeue is 34.4's` };
  }
  let allowed = false; let reason = why;
  if (row.kind === "transient" && conf >= CONFIDENCE_FLOOR) allowed = true;
  else if (row.kind === "adapter_down") {
    const rec = row.classified_at ? await d.q.query<{ n: string }>(`SELECT count(*)::text AS n FROM outbox_dispatches WHERE adapter = $1 AND outcome = 'acked' AND finished_at > $2::timestamptz AND finished_at <= $3::timestamptz`, [row.adapter, row.classified_at, d.now]) : [];
    if (rec[0] && rec[0].n !== "0") { allowed = true; reason = "adapter_recovered"; } else return { ok: false, code: "CONFIDENCE_FLOOR_0_85", reason: `adapter_down: ${row.adapter} has had no successful send since ${row.classified_at ?? "classification"}; the automatic requeue waits for the outage to end (rule 4)` };
  }
  if (!allowed) return { ok: false, code: "CONFIDENCE_FLOOR_0_85", reason: `${row.kind} at ${conf}: ${row.kind === "poison" || row.kind === "needs_person" ? `${row.kind} is never requeued by the agent` : "below the confidence floor 0.85"} (rule 4); a person requeues through 34.4` };
  const m = (await d.q.query<{ id: string; adapter: string; status: string; idempotency_key: string; loan_id: string | null }>(`SELECT id::text AS id, adapter, status, idempotency_key, loan_id::text AS loan_id FROM integration_messages WHERE id = $1::uuid`, [row.source_id]))[0];
  if (!m) return { ok: false, code: "NO_SUCH_MESSAGE", reason: `no outbox message ${row.source_id}` };
  if (m.status !== "dead" && m.status !== "failed") return { ok: false, code: "NOT_REQUEUEABLE", reason: `message ${m.id} is ${m.status}; only a dead or failed message is requeued` };
  const requeueNo = row.auto_requeues + 1;
  // 34.4's one writer of the reset (status queued, attempts 0, next_attempt_at now, error cleared)
  if (!(await resetForRequeue(d.q, m.id, d.now)).length) return { ok: false, code: "NOT_REQUEUEABLE", reason: `message ${m.id} changed under the requeue` };
  await d.q.query(`UPDATE ops_exceptions SET auto_requeues = auto_requeues + 1, status = CASE WHEN status = 'open' THEN 'triaged' ELSE status END WHERE id = $1::uuid`, [row.id]);
  const triagedEv = triagedIfFirst(d, row, "requeue");
  // 34.4's literal, the agent's bounded act: never a hand requeue (REQUEUE_CAP_3 counts human `by` only)
  const ev = d.events.append({ type: EV.requeued, aggregate: { kind: "integration_message", id: m.id }, actor: d.actor, ...(m.loan_id ? { loanId: m.loan_id } : {}), payload: { message_id: m.id, adapter: m.adapter, idempotency_key: m.idempotency_key, from_status: m.status, requeue_no: requeueNo, cap: AUTO_REQUEUE_CAP, by: byOf(STEWARD_ACTOR), by_role: null, auto: true, reason, exception_id: row.id } });
  decision(d, { subject: { kind: "ops_exception", id: row.id }, action: "ops.exceptions.requeue:auto", kind: row.kind, confidence: conf, rationale: `requeued ${m.adapter} message ${m.id} once (${reason}); auto_requeues = ${requeueNo} of ${AUTO_REQUEUE_CAP}`, eventId: ev.id });
  triage(d, { exception_id: row.id, action: "requeue_auto", kind: row.kind, confidence: conf, signals: { requeue_no: requeueNo, cap: AUTO_REQUEUE_CAP, reason }, reason, event_id: ev.id ?? triagedEv?.id, decision_action: "ops.exceptions.requeue:auto" });
  return { ok: true, code: "REQUEUED", reason, requeue_no: requeueNo };
}
/** `op: propose` — the requeue is a person's: a requeue_proposed triage row and the assignment to ops_analyst. */
export async function requeuePropose(d: StewardDeps, row: ExceptionRow, reason: string): Promise<{ proposed: true; assigned_role: "ops_analyst" }> {
  const triagedEv = triagedIfFirst(d, row, "requeue");
  decision(d, { subject: { kind: "ops_exception", id: row.id }, action: "ops.exceptions.requeue:propose", kind: row.kind, confidence: 1, rationale: `proposed a hand requeue of ${row.source_kind} ${row.source_id}: ${reason}`, eventId: triagedEv?.id });
  triage(d, { exception_id: row.id, action: "requeue_proposed", kind: row.kind, confidence: Number(row.confidence ?? 0), reason, assigned_role: "ops_analyst", event_id: triagedEv?.id ?? null, decision_action: "ops.exceptions.requeue:propose" });
  await assignException(d, { exception_id: row.id, role: "ops_analyst", reason }, { ...row, status: row.status === "open" ? "triaged" : row.status });
  return { proposed: true, assigned_role: "ops_analyst" };
}
export async function requeueException(d: StewardDeps, i: { exception_id: string; op: "auto" | "propose"; reason?: string | null }): Promise<Row> {
  const row = await requireLive(d, i.exception_id);
  if (i.op === "propose") return { exception_id: row.id, ...(await requeuePropose(d, row, i.reason?.trim() || `a person's requeue of ${row.source_id}`)) };
  const r = await requeueAuto(d, row, "manual");
  if (!r.ok) throw new StewardRefused(409, r.code, r.reason, { exception_id: row.id, kind: row.kind, confidence: Number(row.confidence ?? 0) });
  return { exception_id: row.id, requeued: true, requeue_no: r.requeue_no, reason: r.reason, auto: true };
}

// ---------------------------------------------------------------- assign / resolve
export async function assignException(d: StewardDeps, i: { exception_id: string; role: string; reason: string }, known?: ExceptionRow): Promise<Row> {
  const row = known ?? (await requireLive(d, i.exception_id));
  const triagedEv = triagedIfFirst(d, row, "assign");
  await d.q.query(`UPDATE ops_exceptions SET status = 'assigned', owner_role = $2, assigned_at = $3::timestamptz WHERE id = $1::uuid`, [row.id, i.role, d.now]);
  const ev = d.events.append({ type: EV.assigned, aggregate: agg(row.id), actor: d.actor, payload: { exception_id: row.id, role: i.role, by: byOf(d.actor), reason: i.reason, environment: row.environment } });
  decision(d, { subject: { kind: "ops_exception", id: row.id }, action: "ops.exceptions.assign", kind: row.kind, confidence: 1, rationale: `assigned to ${i.role}: ${i.reason}`, eventId: ev.id });
  triage(d, { exception_id: row.id, action: "assigned", kind: row.kind, confidence: Number(row.confidence ?? 0), assigned_role: i.role, reason: i.reason, event_id: ev.id ?? triagedEv?.id, decision_action: "ops.exceptions.assign" });
  return { exception_id: row.id, status: "assigned", owner_role: i.role, assigned_at: d.now };
}
export interface ResolveInput { readonly exception_id: string; readonly disposition: "resolved" | "abandoned"; readonly reason?: string | null; /** the source event that resolved it (a receipt, a sent message) */ readonly cause?: { readonly event_type: string; readonly event_id: string | null; readonly receipt_id?: string | null } | null }
export async function resolveException(d: StewardDeps, i: ResolveInput, known?: ExceptionRow): Promise<Row> {
  const row = known ?? (await requireLive(d, i.exception_id));
  if (i.disposition === "abandoned") {
    if (d.actor.kind !== "human") throw new StewardRefused(403, "ROLE_REQUIRED", "an abandonment is a person's act (ops_analyst)");
    if (!i.reason?.trim()) throw new StewardRefused(409, "REASON_REQUIRED", "abandoned needs the reason");
    if (row.status === "open") throw new StewardRefused(409, "NOT_TRIAGED", `exception ${row.id} is open; classify or assign it before abandoning`);
  }
  await d.q.query(`UPDATE ops_exceptions SET status = $2, resolved_at = $3::timestamptz WHERE id = $1::uuid`, [row.id, i.disposition, d.now]);
  const ev = d.events.append({ type: EV.resolved, aggregate: agg(row.id), actor: d.actor, payload: { exception_id: row.id, disposition: i.disposition, by: byOf(d.actor), resolved_at: d.now, source_kind: row.source_kind, source_id: row.source_id, adapter: row.adapter, kind: row.kind, environment: row.environment, cause: i.cause?.event_type ?? "person" } });
  let recovered: DomainEvent | null = null;
  if (row.source_kind === "cycle_registry" && i.disposition === "resolved") {
    const [cycle_code, period_key] = splitSource(row.source_id);
    recovered = d.events.append({ type: EV.cycleRecovered, aggregate: agg(row.id), actor: d.actor, payload: { cycle_code, period_key, receipt_id: i.cause?.receipt_id ?? null, exception_id: row.id, recovered_at: d.now } });
  }
  decision(d, { subject: { kind: "ops_exception", id: row.id }, action: `ops.exceptions.resolve:${i.disposition}`, kind: row.kind, confidence: 1, rationale: i.disposition === "abandoned" ? `abandoned by ${byOf(d.actor)}: ${i.reason}` : `resolved: ${i.cause ? `${i.cause.event_type} for ${row.source_kind} ${row.source_id}` : i.reason?.trim() || `by ${byOf(d.actor)}`}`, eventId: ev.id });
  triage(d, { exception_id: row.id, action: i.disposition, kind: row.kind, confidence: Number(row.confidence ?? 0), reason: i.reason ?? i.cause?.event_type ?? null, signals: i.cause ? { cause: i.cause.event_type, source_event_id: i.cause.event_id } : {}, event_id: recovered?.id ?? ev.id, decision_action: `ops.exceptions.resolve:${i.disposition}` });
  return { exception_id: row.id, status: i.disposition, resolved_at: d.now };
}
const splitSource = (source_id: string): [string, string] => { const k = source_id.indexOf(":"); return k < 0 ? [source_id, ""] : [source_id.slice(0, k), source_id.slice(k + 1)]; };

// ---------------------------------------------------------------- the registry watch (rule 2)
export interface WatchResult { readonly as_of: string; readonly overdue: number; readonly opened: readonly { exception_id: string; cycle_code: string; period_key: string; consecutive_misses: number; escalation_id: string }[]; readonly already_open: number; readonly feeds: Pick<Feeds, "cycle_registry" | "cycle_receipts"> }
export async function watchCycles(d: StewardDeps, i: { as_of?: string; cycle_codes?: readonly string[] | null } = {}): Promise<WatchResult> {
  const asOf = i.as_of ?? d.now;
  const feeds = await feedsOf(d.q);
  const opened: WatchResult["opened"][number][] = []; let already = 0;
  const overdue = (await d.ports.cycles.overdue(d.q, asOf)).filter((c) => !i.cycle_codes?.length || i.cycle_codes.includes(c.cycle_code));
  for (const c of overdue) {
    if (await d.ports.cycles.hasReceipt(d.q, c.cycle_code, c.period_key)) continue;
    const source_id = `${c.cycle_code}:${c.period_key}`;
    if (await liveException(d.q, "cycle_registry", source_id)) { already++; continue; }
    // consecutive misses: 1 + the previous, still unresolved miss of the same cycle (a resolved one had its receipt)
    const prev = (await d.q.query<{ n: string }>(`SELECT coalesce((SELECT t.signals->>'consecutive_misses' FROM exception_triages t WHERE t.exception_id = e.id AND t.action = 'opened' LIMIT 1), '1') AS n FROM ops_exceptions e WHERE e.source_kind = 'cycle_registry' AND e.source_id LIKE $1 AND e.source_id <> $2 AND e.status IN ('open', 'triaged', 'assigned', 'abandoned') ORDER BY e.opened_at DESC LIMIT 1`, [`${c.cycle_code}:%`, source_id]))[0];
    const consecutive = prev ? Number(prev.n) + 1 : 1;
    const runbook = await runbookForCycle(d.q, c.cycle_code, d.ports);
    const o = await openException(d, { source_kind: "cycle_registry", source_id, kind: "missed_cycle", owner_role: c.escalation_role ?? "ops_analyst", signals: { consecutive_misses: consecutive, next_expected_by: c.next_expected_by, owner_process: c.owner_process, owner_agent: c.owner_agent } });
    await classifyException(d, { exception_id: o.exception_id, follow_up: false });
    d.events.append({ type: EV.cycleMissed, aggregate: agg(o.exception_id), actor: d.actor, payload: { cycle_code: c.cycle_code, period_key: c.period_key, next_expected_by: c.next_expected_by, detected_at: d.now, consecutive_misses: consecutive, exception_id: o.exception_id, owner_process: c.owner_process, owner_agent: c.owner_agent } });
    const esc = d.escalations.open({ kind: "sev2", ownerRole: "ops_analyst", severity: "2", payload: { code: "MISSED_CYCLE", cycle_code: c.cycle_code, period_key: c.period_key, next_expected_by: c.next_expected_by, overdue_since: c.overdue_since, owner_process: c.owner_process, owner_agent: c.owner_agent, consecutive_misses: consecutive, exception_id: o.exception_id, runbook, opened_by: byOf(d.actor) } }, d.actor);
    d.deferWrite(async (q) => { await q.query(`UPDATE ops_exceptions SET escalation_id = $2::uuid WHERE id = $1::uuid`, [o.exception_id, esc.id]); });
    opened.push({ exception_id: o.exception_id, cycle_code: c.cycle_code, period_key: c.period_key, consecutive_misses: consecutive, escalation_id: esc.id });
  }
  return { as_of: asOf, overdue: overdue.length, opened, already_open: already, feeds: { cycle_registry: feeds.cycle_registry, cycle_receipts: feeds.cycle_receipts } };
}

// ---------------------------------------------------------------- the intake of the other sources (events read by literal from loan_events)
type Ev = { id: string; type: string; occurred_at: string; payload: Row; loan_id: string | null; application_id: string | null; actor_id: string };
const unhandled = async (q: Queryable, type: string, since: string | null, extra = ""): Promise<Ev[]> => q.query<Ev>(`SELECT e.id::text AS id, e.type, e.occurred_at::text AS occurred_at, e.payload, e.loan_id::text AS loan_id, e.application_id::text AS application_id, e.actor_id FROM loan_events e WHERE e.type = $1 AND ($2::timestamptz IS NULL OR e.occurred_at >= $2::timestamptz) ${extra} AND NOT EXISTS (SELECT 1 FROM exception_triages t WHERE t.signals->>'source_event_id' = e.id::text) ORDER BY e.sequence LIMIT 500`, [type, since]);

export interface IntakeResult { readonly dead_messages: { opened: number; escalated: number }; readonly stalled_runs: number; readonly dead_units: number; readonly unstaffed_roles: number }
export async function intakeSources(d: StewardDeps, o: { since?: string | null } = {}): Promise<IntakeResult> {
  const since = o.since ?? null;
  let dmOpened = 0, dmEsc = 0, stalled = 0, deadUnits = 0, unstaffed = 0;
  for (const e of await unhandled(d.q, "integration.message.dead", since)) {
    const message_id = s(e.payload["message_id"]); if (!isUuid(message_id)) continue;
    const live = await liveException(d.q, "integration_message", message_id);
    if (live) {
      // the same message died again after its one automatic requeue: a triage row `escalated`, no second requeue, assigned to a person
      triage(d, { exception_id: live.id, action: "escalated", kind: live.kind, confidence: Number(live.confidence ?? 0), signals: { source_event_id: e.id, attempts: Number(e.payload["attempts"] ?? 0), failure: s(e.payload["failure"]) || null, auto_requeues: live.auto_requeues }, reason: `died again (${s(e.payload["failure"]) || "dead"}) after ${live.auto_requeues} automatic requeue(s); a person's hand requeue via 34.4 is the only path` });
      decision(d, { subject: { kind: "ops_exception", id: live.id }, action: "ops.exceptions.escalate", kind: live.kind, confidence: 1, rationale: `message ${message_id} died again; AUTO_REQUEUE_CAP_1 holds` });
      if (live.status !== "assigned") await assignException(d, { exception_id: live.id, role: "ops_analyst", reason: `AUTO_REQUEUE_CAP_1: message ${message_id} died again after its automatic requeue; a person's hand requeue is the only path (34.4)` }, live);
      dmEsc++; continue;
    }
    const resolvedLater = (await d.q.query<{ n: string }>(`SELECT count(*)::text AS n FROM ops_exceptions WHERE source_kind = 'integration_message' AND source_id = $1 AND resolved_at >= $2::timestamptz`, [message_id, e.occurred_at]))[0]!.n !== "0";
    if (resolvedLater) { triage(d, { exception_id: (await d.q.query<{ id: string }>(`SELECT id::text AS id FROM ops_exceptions WHERE source_kind = 'integration_message' AND source_id = $1 ORDER BY opened_at DESC LIMIT 1`, [message_id]))[0]!.id, action: "escalated", signals: { source_event_id: e.id, note: "an earlier death of a message already resolved" } }); continue; }
    const o2 = await openException(d, { source_kind: "integration_message", source_id: message_id, adapter: s(e.payload["adapter"]) || null, loan_id: e.loan_id ?? (e.payload["loan_id"] as string | null), source_event_id: e.id, signals: { attempts: Number(e.payload["attempts"] ?? 0), failure: s(e.payload["failure"]) || null, error_class: s(e.payload["failure"]) || null } });
    if (o2.created) dmOpened++;
  }
  for (const e of await unhandled(d.q, "timer.breached", since, `AND e.payload->>'code' IN ('${CYCLE_MISSED_CODE}', '${ADAPTER_DOWN_CODE}', '${STALLED_RUN_CODE}')`)) {
    const code = s(e.payload["code"]); const timer_id = s(e.payload["timer_id"]);
    if (code === CYCLE_MISSED_CODE || code === ADAPTER_DOWN_CODE) {
      // this process's own clock breached: the breach pass opened the escalation (enriched by BREACH_ENRICHERS); the exception's record gets the `escalated` triage row
      const t = isUuid(timer_id) ? (await d.q.query<{ subject_id: string; subject_kind: string }>(`SELECT subject_id, subject_kind FROM timers WHERE id = $1::uuid`, [timer_id]))[0] : undefined;
      const x = t?.subject_kind === "ops_exception" ? await exceptionById(d.q, t.subject_id) : null;
      if (x) triage(d, { exception_id: x.id, action: "escalated", kind: x.kind, confidence: Number(x.confidence ?? 0), signals: { source_event_id: e.id, timer_code: code, timer_id, severity: e.payload["severity"] ?? null }, reason: `${code} breached: ${s(e.payload["breach"])}` });
      continue;
    }
    if (code !== STALLED_RUN_CODE) continue;
    const t = isUuid(timer_id) ? (await d.q.query<{ subject_id: string }>(`SELECT subject_id FROM timers WHERE id = $1::uuid`, [timer_id]))[0] : undefined;
    const run_id = t?.subject_id ?? timer_id;
    const o2 = await openException(d, { source_kind: "cycle_run", source_id: run_id, kind: "stalled_run", source_event_id: e.id, signals: { timer_id, timer_code: STALLED_RUN_CODE } });
    if (o2.created) { await classifyException(d, { exception_id: o2.exception_id, follow_up: false }); stalled++; }
  }
  for (const e of await unhandled(d.q, "job.unit.dead", since)) {
    const job_id = s(e.payload["job_id"]); if (!job_id) continue;
    const o2 = await openException(d, { source_kind: "job", source_id: job_id, kind: "dead_unit", loan_id: e.loan_id, source_event_id: e.id, signals: { cycle_code: s(e.payload["cycle_code"]), period_key: s(e.payload["period_key"]), unit_id: s(e.payload["unit_id"]), attempts: Number(e.payload["attempts"] ?? 0), error_class: s(e.payload["error_class"]) || null } });
    if (o2.created) { await classifyException(d, { exception_id: o2.exception_id, follow_up: false }); await assignException(d, { exception_id: o2.exception_id, role: "ops_analyst", reason: `dead unit ${s(e.payload["unit_id"])} of ${s(e.payload["cycle_code"])} ${s(e.payload["period_key"])} (${s(e.payload["error_class"]) || "dead"}): requeue or abandon is a person's (35.3 rule 7)` }); deadUnits++; }
  }
  for (const e of await unhandled(d.q, "role.queue.unstaffed", since)) {
    const role = s(e.payload["role"]); if (!role) continue;
    const env = s(e.payload["environment"]) || d.environment;
    const o2 = await openException(d, { source_kind: "role_queue", source_id: `${env}:${role}`, kind: "unstaffed_role", environment: env, source_event_id: e.id, signals: { role, environment: env } });
    if (o2.created) { await classifyException(d, { exception_id: o2.exception_id, follow_up: false }); unstaffed++; }
  }
  return { dead_messages: { opened: dmOpened, escalated: dmEsc }, stalled_runs: stalled, dead_units: deadUnits, unstaffed_roles: unstaffed };
}

/** The source-driven resolutions (state machine: `integration.message.sent` for the message, `cycle.run.completed` for the cycle or run, `job.unit.resolved` for the unit, `escalation.completed` for the escalation, `role.staffed` for the role). */
export async function resolveFromSources(d: StewardDeps): Promise<{ resolved: number; recovered: number }> {
  const live = await d.q.query<ExceptionRow>(`SELECT ${EXCEPTION_COLS} FROM ops_exceptions WHERE status = ANY($1::text[]) ORDER BY opened_at`, [[...LIVE_STATUSES]]);
  let resolved = 0, recovered = 0;
  const first = async (sql: string, params: unknown[]): Promise<Ev | null> => (await d.q.query<Ev>(`SELECT id::text AS id, type, occurred_at::text AS occurred_at, payload, loan_id::text AS loan_id, application_id::text AS application_id, actor_id FROM loan_events WHERE ${sql} ORDER BY sequence LIMIT 1`, params))[0] ?? null;
  for (const x of live) {
    let cause: Ev | null = null; let receipt: string | null = null;
    switch (x.source_kind) {
      case "integration_message": cause = await first(`type = 'integration.message.sent' AND payload->>'message_id' = $1 AND occurred_at >= $2::timestamptz`, [x.source_id, x.opened_at]); break;
      case "cycle_registry": { const [code, period] = splitSource(x.source_id); cause = await first(`type = 'cycle.run.completed' AND payload->>'cycle_code' = $1 AND payload->>'period_key' = $2`, [code, period]); receipt = cause ? s(cause.payload["receipt_id"]) || null : null; break; }
      case "cycle_run": cause = await first(`type = 'cycle.run.completed' AND payload->>'run_id' = $1 AND occurred_at >= $2::timestamptz`, [x.source_id, x.opened_at]); receipt = cause ? s(cause.payload["receipt_id"]) || null : null; break;
      case "job": cause = await first(`type = 'job.unit.resolved' AND payload->>'job_id' = $1 AND occurred_at >= $2::timestamptz`, [x.source_id, x.opened_at]); break;
      case "escalation": cause = await first(`type = 'escalation.completed' AND payload->>'escalation_id' = $1 AND occurred_at >= $2::timestamptz`, [x.source_id, x.opened_at]); break;
      case "role_queue": { const [, role] = splitSource(x.source_id); cause = await first(`type = 'role.staffed' AND payload->>'role' = $1 AND occurred_at >= $2::timestamptz`, [role, x.opened_at]); break; }
      default: break;
    }
    if (!cause) continue;
    await resolveException(d, { exception_id: x.id, disposition: "resolved", cause: { event_type: cause.type, event_id: cause.id, receipt_id: receipt } }, x);
    resolved++; if (x.source_kind === "cycle_registry") recovered++;
  }
  return { resolved, recovered };
}

/** Rule 4 for the adapters classified down: one automatic requeue per message once the adapter has a success after `classified_at`. */
export async function requeueRecovered(d: StewardDeps): Promise<{ requeued: number; assigned: number }> {
  const rows = await d.q.query<ExceptionRow>(`SELECT ${EXCEPTION_COLS} FROM ops_exceptions WHERE source_kind = 'integration_message' AND kind = 'adapter_down' AND status IN ('triaged', 'assigned') AND auto_requeues < $1 ORDER BY opened_at`, [AUTO_REQUEUE_CAP]);
  let requeued = 0, assigned = 0;
  for (const x of rows) { const r = await requeueAuto(d, x, "adapter_recovered"); if (r.ok) requeued++; else if (r.code === "AUTO_REQUEUE_CAP_1") assigned++; }
  return { requeued, assigned };
}

/** Every `open` exception classified once, automatically (rule 3), with rule 4's follow-up. */
export async function classifyOpen(d: StewardDeps): Promise<{ classified: number; requeued: number; proposed: number }> {
  const rows = await d.q.query<{ id: string }>(`SELECT id::text AS id FROM ops_exceptions WHERE status = 'open' ORDER BY opened_at`);
  let classified = 0, requeued = 0, proposed = 0;
  for (const r of rows) { const c = await classifyException(d, { exception_id: r.id }); classified++; if (c.follow_up === "requeued") requeued++; if (c.follow_up === "proposed") proposed++; }
  return { classified, requeued, proposed };
}

// ---------------------------------------------------------------- the pass (every sweep, before the breach pass) and the breach actions (after it)
export interface StewardSweepReport {
  readonly at: string; readonly as_of_date: string; readonly environment: string; readonly feeds: Feeds;
  readonly cycles: WatchResult | null; readonly intake: IntakeResult | null; readonly classified: { classified: number; requeued: number; proposed: number } | null; readonly recovered_requeues: { requeued: number; assigned: number } | null; readonly resolutions: { resolved: number; recovered: number } | null;
  readonly report: DailyReportResult | null; readonly errors: readonly string[]; readonly line: string;
}
/** One unit of work of the pass: the escalations it opened are saved and the deferred rows written in its commit. */
export async function stewardUnit<T>(rt: Runtime, nowIso: string, fn: (d: StewardDeps) => Promise<T>, o: { actor?: Actor; ports?: StewardPorts; environment?: string } = {}): Promise<T> {
  const deferred: ((q: Queryable) => Promise<void>)[] = []; let esc: EscalationService | undefined;
  const r = await rt.uow.run({}, async (ctx) => {
    esc = new EscalationService(ctx.events, ctx.clock);
    const d: StewardDeps = { q: ctx.q!, events: ctx.events, clock: ctx.clock, now: nowIso, actor: o.actor ?? STEWARD_ACTOR, escalations: esc, decide: (x) => ctx.decide(x), deferWrite: (f) => { deferred.push(f); }, environment: o.environment ?? rt.environment, ports: portsOf(o.ports), runtime: rt };
    return fn(d);
  }, { clock: rt.clock, commit: async (q) => { for (const e of esc?.list() ?? []) await rt.escalationRepo.save(e, q); for (const f of deferred) await f(q); } });
  return r.result;
}
export async function stewardSweepPass(rt: Runtime, nowIso: string = rt.clock.now(), o: { runId?: string | null; ports?: StewardPorts; report?: boolean } = {}): Promise<StewardSweepReport> {
  const wc = wallClock(Date.parse(nowIso), ET); const asOf = wc.date; const errors: string[] = [];
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => { try { return await fn(); } catch (e) { const msg = e instanceof Error ? e.message : String(e); errors.push(`${name}: ${msg}`); rt.logger?.error(`ops.steward ${name} failed`, { at: nowIso, error: e }); return null; } };
  const feeds = await feedsOf(rt.db);
  const cycles = feeds.cycle_registry === "present" ? await step("cycles.watch", () => stewardUnit(rt, nowIso, (d) => watchCycles(d, { as_of: nowIso }), o)) : null;
  const intake = await step("intake", () => stewardUnit(rt, nowIso, (d) => intakeSources(d), o));
  const classified = await step("classify", () => stewardUnit(rt, nowIso, (d) => classifyOpen(d), o));
  const recoveredRequeues = await step("requeue.recovered", () => stewardUnit(rt, nowIso, (d) => requeueRecovered(d), o));
  const resolutions = await step("resolve", () => stewardUnit(rt, nowIso, (d) => resolveFromSources(d), o));
  // rule 5: the previous day's report on the first sweep at/after 00:15 ET (the demo clock's crossing of a day is such a sweep)
  let report: DailyReportResult | null = null;
  const [hh, mm] = REPORT_AT_ET.split(":").map(Number) as [number, number];
  if (o.report !== false && wc.hour * 60 + wc.minute >= hh * 60 + mm && !(await reportRanOn(rt.db, rt.environment, asOf))) {
    const yesterday = wallClock(Date.parse(nowIso) - 86_400_000, ET).date;
    report = await step("report", () => stewardUnit(rt, nowIso, (d) => runDailyReport(d, { environment: rt.environment, as_of_date: yesterday, produced_by: o.runId ? `sweep:${o.runId}` : "sweep", agents: rt.agents }), o));
  }
  const line = `ops steward ${asOf}: feeds absent=[${Object.entries(feeds).filter(([, v]) => v === "absent").map(([k]) => k).join(",")}] cycles_opened=${cycles?.opened.length ?? 0} dead_opened=${intake?.dead_messages.opened ?? 0} dead_escalated=${intake?.dead_messages.escalated ?? 0} classified=${classified?.classified ?? 0} requeued=${(classified?.requeued ?? 0) + (recoveredRequeues?.requeued ?? 0)} resolved=${resolutions?.resolved ?? 0} report=${report ? `${report.as_of_date}:${report.changed ? "changed" : "unchanged"}` : "-"} errors=${errors.length}`;
  return { at: nowIso, as_of_date: asOf, environment: rt.environment, feeds, cycles, intake, classified, recovered_requeues: recoveredRequeues, resolutions, report, errors, line };
}

/**
 * The breach pass's enrichers for this process's clocks (src/runtime/app.ts consults BREACH_ENRICHERS when it opens the
 * escalation of a breach, in the breach pass's own transaction): SM_OPS_ADAPTER_DOWN_1H's escalation names the adapter and the
 * dead count D15; SM_OPS_CYCLE_MISSED_2H's names the cycle, the period and `consecutive_misses`, and when `consecutive_misses ≥ 2`
 * the row's second clause makes it sev 1 → `compliance`. Reads only: the steward completes nothing, edits no clock and updates no
 * escalation (rule 1).
 */
export interface BreachEnrichment { readonly payload?: Row; readonly severity?: 1 | 2 | 3 | 4; readonly ownerRole?: string }
export type BreachEnricher = (q: Queryable, instance: { readonly id: string; readonly code: string; readonly subject: { readonly kind: string; readonly id: string } }, nowIso: string) => Promise<BreachEnrichment | null>;
export const BREACH_ENRICHERS: ReadonlyMap<string, BreachEnricher> = new Map<string, BreachEnricher>([
  [ADAPTER_DOWN_CODE, async (q, inst, nowIso) => {
    if (inst.subject.kind !== "ops_exception") return null;
    const x = await exceptionById(q, inst.subject.id); if (!x) return null;
    const sig = await messageSignals(q, { message_id: x.source_id, adapter: x.adapter ?? "", now: nowIso });
    return { payload: { code: "ADAPTER_DOWN_1H", exception_id: x.id, adapter: x.adapter, message_id: x.source_id, kind: x.kind, D15: sig.D15, S60: sig.S60, classified_at: x.classified_at, runbook: runbookForTimer(ADAPTER_DOWN_CODE)?.breach_text ?? null } };
  }],
  [CYCLE_MISSED_CODE, async (q, inst, _nowIso) => {
    if (inst.subject.kind !== "ops_exception") return null;
    const x = await exceptionById(q, inst.subject.id); if (!x) return null;
    const [cycle_code, period_key] = splitSource(x.source_id);
    const opened = (await q.query<{ signals: Row }>(`SELECT signals FROM exception_triages WHERE exception_id = $1::uuid AND action = 'opened' LIMIT 1`, [x.id]))[0];
    const consecutive = Number(opened?.signals["consecutive_misses"] ?? 1);
    const runbook = await runbookForCycle(q, cycle_code);
    const payload: Row = { code: consecutive >= 2 ? "CYCLE_MISSED_TWICE" : "CYCLE_MISSED", exception_id: x.id, cycle_code, period_key, consecutive_misses: consecutive, runbook };
    return consecutive >= 2 ? { payload, severity: 1, ownerRole: "compliance" } : { payload };
  }],
]);

// ---------------------------------------------------------------- reads
export interface ListFilter { readonly environment?: string | null; readonly status?: string | null; readonly kind?: string | null; readonly adapter?: string | null; readonly source_kind?: string | null; readonly limit?: number | null }
export async function listExceptions(q: Queryable, f: ListFilter = {}): Promise<{ count: number; exceptions: (ExceptionRow & { triages: Row[] })[] }> {
  const where: string[] = []; const p: unknown[] = [];
  const add = (col: string, v: unknown) => { if (typeof v === "string" && v.trim()) { p.push(v.trim()); where.push(`${col} = $${p.length}`); } };
  add("environment", f.environment); add("kind", f.kind); add("adapter", f.adapter); add("source_kind", f.source_kind);
  if (typeof f.status === "string" && f.status.trim()) { if (f.status === "live") { p.push([...LIVE_STATUSES]); where.push(`status = ANY($${p.length}::text[])`); } else add("status", f.status); }
  const n = Number(f.limit); p.push(Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 2000) : 200);
  const rows = await q.query<ExceptionRow>(`SELECT ${EXCEPTION_COLS} FROM ops_exceptions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY opened_at DESC, id LIMIT $${p.length}`, p);
  const out = [] as (ExceptionRow & { triages: Row[] })[];
  for (const r of rows) out.push({ ...r, triages: await q.query<Row>(`SELECT id::text AS id, action, kind, confidence::text AS confidence, signals, actor_kind::text AS actor_kind, actor_id, actor_role, assigned_role, reason, decision_id::text AS decision_id, event_id::text AS event_id, created_at::text AS created_at FROM exception_triages WHERE exception_id = $1::uuid ORDER BY created_at, id`, [r.id]) });
  return { count: out.length, exceptions: out };
}
export const isLiveStatus = (st: string): st is ExceptionStatus => (LIVE_STATUSES as readonly string[]).includes(st);
export { PROCESS_35_11, STEWARD_AGENT, STEWARD_ACTOR, isProduction };
export type { EscalationKind };
