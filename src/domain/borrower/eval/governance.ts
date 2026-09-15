/**
 * Governance of the `borrower-conversation` AI system (docs/ux/17 §3.6, §6 — DELTA-28; 18.1 rules D.3 and D.5) on the 0021 tables:
 *
 *   selectVersion            32.16-T23: an `ai_system_versions` row is selected (status `deployed`, the turn stamps its id on every
 *                            `agent_turns` row) only through 18.1's SM_AI_EVAL_GATE — its `eval_run_id` must point at a passing
 *                            `ai_evaluations` row and a T2 version needs the ai_governance_owner's approval (18.1 deployVersion). A row without
 *                            a passing evaluation is refused and nothing changes.
 *   writeDailyMetrics        one `ai_monitoring_metrics` row per day from `agent_turns` and the event log: transfers per session
 *                            (`escalation_rate`), guard rejections per turn (`low_confidence_rate`), tool errors, the ask-for-a-person rate,
 *                            latency p95, misses per card and the time to `du.findings.received` (in `fairness_stats`, the row's jsonb).
 *   evaluateKillSwitch       32.16-T24 / 18.1 rule D.5: two consecutive days with transfers per session outside the band trip the kill
 *                            switch — `feature_flags.<agent>.enabled = false` for both thread-owning agents and `borrower-conversation.enabled`,
 *                            the registry's AI-off state (AgentRegistry.tripKillSwitch), `kill_switch_triggered` on the day's row and an
 *                            `ai.kill_switch.tripped` event — and the borrower turn answers the placeholder for every party (T10) until reset.
 *   resetKillSwitch          the operator's reset: the flags back to true, the registry's AI-off cleared.
 */
import type { Queryable } from "../../../infra/db/index.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { deployVersion, T1_OVERRIDE_BAND, type AiVersion } from "../../qc-audit/ops-18-1.ts";
import { plainDate } from "../../../kernel/calendar/date.ts";

export const AI_SYSTEM_CODE = "borrower-conversation";
export const AI_TIER = "T2_borrower_facing" as const;
/** The thread-owning agents the conversation runs as (docs/ux/17 §3.1): the kill switch trips both. */
export const CONVERSATION_AGENTS = ["intake", "borrower-comms"] as const;
/** The 18.1 rule D.5 band, applied to transfers per session on the T2 conversation (docs/ux/17 §5 `ai_monitoring_metrics`): below it the agent is not offering a person, above it the model or the rules drift. */
export const TRANSFERS_PER_SESSION_BAND = T1_OVERRIDE_BAND;
export const KILL_SWITCH_DAYS = 2;

export class GovernanceRefused extends Error { readonly code: string; readonly gate: string | null; constructor(code: string, message: string, gate: string | null = null) { super(message); this.name = "GovernanceRefused"; this.code = code; this.gate = gate; } }

export interface VersionRow extends Record<string, unknown> { readonly id: string; readonly system_code: string; readonly version: string; readonly model_id: string | null; readonly prompt_hash: string | null; readonly eval_run_id: string | null; readonly approved_by: string | null; readonly approved_at: string | null; readonly change_kind: "new" | "minor" | "major"; readonly status: string; readonly eval_pass: boolean | null; readonly eval_suite_code: string | null }
export async function versionRow(db: Queryable, versionId: string): Promise<VersionRow | undefined> {
  return (await db.query<VersionRow>(`SELECT v.id::text AS id, v.system_code, v.version, v.model_id, v.prompt_hash, v.eval_run_id::text AS eval_run_id, v.approved_by, v.approved_at::text AS approved_at, v.change_kind, v.status, e.pass AS eval_pass, e.suite_code AS eval_suite_code FROM ai_system_versions v LEFT JOIN ai_evaluations e ON e.id = v.eval_run_id AND e.version_id = v.id WHERE v.id = $1`, [versionId]))[0];   // the evaluation must be this version's own (never another version's pointer)
}
/** The version the turn runs under: the `deployed` row of the system (null while none is selected). */
export async function selectedVersion(db: Queryable, system_code = AI_SYSTEM_CODE): Promise<VersionRow | null> {
  const row = (await db.query<{ id: string }>(`SELECT id::text AS id FROM ai_system_versions WHERE system_code = $1 AND status = 'deployed' ORDER BY approved_at DESC NULLS LAST, id LIMIT 1`, [system_code]))[0];
  return row ? (await versionRow(db, row.id)) ?? null : null;
}
export interface Approver { readonly kind: "human"; readonly id: string; readonly role: "officer"; readonly designation: "ai_governance_owner" }
/**
 * 32.16-T23 / 18.1 rule D.3: select a version for `borrower-conversation`. Refused (`SM_AI_EVAL_GATE`) when the row has no `eval_run_id`, when
 * that evaluation did not pass, or — a T2 system — when no ai_governance_owner approves; the previous `deployed` row is retired.
 */
export async function selectVersion(runtime: Runtime, i: { version_id: string; approver?: Approver | null; now: string; system_code?: string }): Promise<{ version: VersionRow; retired: string | null; gate: "SM_AI_EVAL_GATE"; already_selected: boolean }> {
  const system_code = i.system_code ?? AI_SYSTEM_CODE; const db = runtime.db;
  const v = await versionRow(db, i.version_id);
  if (!v) throw new GovernanceRefused("AI_VERSION_UNKNOWN", `no ai_system_versions row ${i.version_id}`);
  if (v.system_code !== system_code) throw new GovernanceRefused("AI_VERSION_SYSTEM", `${v.system_code}@${v.version} is not a ${system_code} version`);
  if (v.status === "deployed") return { version: v, retired: null, gate: "SM_AI_EVAL_GATE", already_selected: true };
  if (v.status === "retired" || v.status === "rolled_back") throw new GovernanceRefused("SM_AI_EVAL_GATE", `${v.version} is ${v.status}: a fresh evaluation (a new ai_evaluations row as its eval_run_id) comes before it is selected again`, "SM_AI_EVAL_GATE");
  const suites = !v.eval_run_id ? [{ suite_code: "no evaluation (eval_run_id is null)", mandatory: true, pass: false }] : v.eval_pass === null ? [{ suite_code: "no evaluation of this version (eval_run_id names another version's run)", mandatory: true, pass: false }] : [{ suite_code: v.eval_suite_code ?? "unknown", mandatory: true, pass: v.eval_pass === true }];
  // 18.1 rule D.3: the approver is the ai_governance_owner officer (approveVersion's own check), never a shape the caller asserts
  const approver = i.approver ?? null;
  if (approver && !(approver.kind === "human" && approver.role === "officer" && approver.designation === "ai_governance_owner" && approver.id)) throw new GovernanceRefused("SM_AI_EVAL_GATE", "ai_system_versions: approved_by is officer:ai_governance_owner", "SM_AI_EVAL_GATE");
  const approved_by = approver?.id ?? v.approved_by ?? null;
  const facts: AiVersion = { system_code, version: v.version, tier: AI_TIER, change_kind: v.change_kind, status: approved_by ? "approved" : "evaluated", suites, approved_by };
  const d = deployVersion(facts, plainDate(i.now.slice(0, 10)));
  if (!d.allowed || !d.event) throw new GovernanceRefused("SM_AI_EVAL_GATE", d.refusal ?? "the evaluation gate is closed", d.gate);
  let retired: string | null = null;
  await db.tx(async (q) => {
    const prior = (await q.query<{ id: string }>(`SELECT id::text AS id FROM ai_system_versions WHERE system_code = $1 AND status = 'deployed' FOR UPDATE`, [system_code])).map((r) => r.id).filter((id) => id !== v.id);
    for (const id of prior) await q.query(`UPDATE ai_system_versions SET status = 'retired' WHERE id = $1`, [id]);
    retired = prior[0] ?? null;
    await q.query(`UPDATE ai_system_versions SET status = 'deployed', approved_by = COALESCE($2, approved_by), approved_at = COALESCE(approved_at, $3) WHERE id = $1`, [v.id, approver?.id ?? null, i.now]);
    await q.query(`UPDATE ai_systems SET model_version = COALESCE($2, model_version), prompt_version = $3 WHERE code = $1`, [system_code, v.model_id, v.version.split("@")[0] ?? v.version]);
  });
  // the 18.1 events: the owner's approval (satisfies SM_AI_EVAL_GATE) and the deployment, on the system's own aggregate
  const { type: deployedType, ...deployed } = d.event;
  await runtime.uow.run({}, (ctx) => {
    if (approver) ctx.events.append({ type: "ai.version.approved", occurredAt: i.now, actor: { kind: "human", id: approver.id, role: "officer" }, aggregate: { kind: "ai_system", id: system_code }, payload: { system_code, version: v.version, version_id: v.id, approved_by: approver.id, eval_run_id: v.eval_run_id } });
    ctx.events.append({ type: deployedType, occurredAt: i.now, actor: approver ? { kind: "human", id: approver.id, role: "officer" } : { kind: "system", id: "18.1-governance" }, aggregate: { kind: "ai_system", id: system_code }, payload: { ...deployed, version_id: v.id, eval_run_id: v.eval_run_id, retired } });
  }, { clock: runtime.clock });
  return { version: (await versionRow(db, v.id))!, retired, gate: "SM_AI_EVAL_GATE", already_selected: false };
}

// ---------------------------------------------------------------- monitoring (docs/ux/17 §5: per day — transfers per session, guard rejections per turn, misses per card, time to du.findings.received)
/** Below this many sessions a day says nothing about transfers per session: the rate is written NULL and never counts toward the kill switch (a quiet weekend is not a breach). */
export const MIN_SESSIONS_PER_DAY = 1;
export interface DailyMetrics { readonly day: string; readonly decision_volume: number; readonly sessions: number; readonly transfers: number; readonly transfers_per_session: number | null; readonly guard_rejections_per_turn: number; readonly tool_error_rate: number; readonly ask_for_human_rate: number; readonly latency_ms_p95: number | null; readonly misses_per_card: number; readonly time_to_du_findings_ms_p50: number | null }
const ratio = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 10000) / 10000 : 0);
/** The day's metrics measured from `agent_turns`, `card_instances` and the event log (UTC day). */
export async function measureDay(db: Queryable, day: string): Promise<DailyMetrics> {
  const from = `${day}T00:00:00.000Z`; const to = `${day}T23:59:59.999Z`;
  const t = (await db.query<{ turns: string; replies: string; rejections: string; sessions: string; tool_calls: string; tool_errors: string; human: string; p95: string | null }>(
    `SELECT count(*)::text AS turns, count(reply_message_id)::text AS replies, count(*) FILTER (WHERE reply_message_id IS NULL)::text AS rejections, count(DISTINCT session_id)::text AS sessions,
            coalesce(sum(jsonb_array_length(tool_calls)), 0)::text AS tool_calls, coalesce(sum((SELECT count(*) FROM jsonb_array_elements(tool_calls) c WHERE (c->>'is_error')::boolean)), 0)::text AS tool_errors,
            count(*) FILTER (WHERE (guard_result->>'human_requested')::boolean)::text AS human,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::text AS p95
     FROM agent_turns WHERE created_at >= $1 AND created_at <= $2 AND channel IN ('app', 'sms', 'email', 'voice', 'video')`, [from, to]))[0]!;
  const transfers = Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE type = 'human.transfer.requested' AND created_at >= $1 AND created_at <= $2`, [from, to]))[0]!.n);
  const cards = (await db.query<{ n: string; misses: string }>(`SELECT count(*)::text AS n, coalesce(sum(misses), 0)::text AS misses FROM card_instances WHERE created_at >= $1 AND created_at <= $2`, [from, to]))[0]!;
  const du = (await db.query<{ p50: string | null }>(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (f.created_at - a.created_at)) * 1000)::text AS p50 FROM loan_events f JOIN applications a ON a.id = f.application_id WHERE f.type = 'du.findings.received' AND f.created_at >= $1 AND f.created_at <= $2`, [from, to]))[0];
  const turns = Number(t.turns); const sessions = Number(t.sessions);
  return { day, decision_volume: Number(t.replies), sessions, transfers, transfers_per_session: sessions >= MIN_SESSIONS_PER_DAY ? ratio(transfers, sessions) : null, guard_rejections_per_turn: ratio(Number(t.rejections), turns), tool_error_rate: ratio(Number(t.tool_errors), Number(t.tool_calls)), ask_for_human_rate: ratio(Number(t.human), turns), latency_ms_p95: t.p95 === null ? null : Math.round(Number(t.p95)), misses_per_card: ratio(Number(cards.misses), Number(cards.n)), time_to_du_findings_ms_p50: du?.p50 === null || du?.p50 === undefined ? null : Math.round(Number(du.p50)) };
}
/** The day's `ai_monitoring_metrics` row (upsert — the day's measurement, not a log); `overrides` let a test state a day's figures. */
export async function writeDailyMetrics(db: Queryable, i: { day: string; system_code?: string; overrides?: Partial<DailyMetrics> }): Promise<DailyMetrics> {
  const system_code = i.system_code ?? AI_SYSTEM_CODE;
  await db.query(`INSERT INTO ai_systems (code, name, kind, purpose, risk_tier, owner_role, consumer_facing) VALUES ($1, 'Borrower conversation', 'agent', 'the borrower thread: the agent turn on the 32.16 bus tools (docs/ux/17)', $2, 'ai_governance_owner', true) ON CONFLICT (code) DO NOTHING`, [system_code, AI_TIER]);
  const m: DailyMetrics = { ...(await measureDay(db, i.day)), ...(i.overrides ?? {}) };
  await db.query(`INSERT INTO ai_monitoring_metrics (system_code, day, decision_volume, escalation_rate, low_confidence_rate, latency_ms_p95, tool_error_rate, ask_for_human_rate, fairness_stats) VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9::jsonb)
                  ON CONFLICT (system_code, day) DO UPDATE SET decision_volume = EXCLUDED.decision_volume, escalation_rate = EXCLUDED.escalation_rate, low_confidence_rate = EXCLUDED.low_confidence_rate, latency_ms_p95 = EXCLUDED.latency_ms_p95, tool_error_rate = EXCLUDED.tool_error_rate, ask_for_human_rate = EXCLUDED.ask_for_human_rate, fairness_stats = EXCLUDED.fairness_stats`,
    [system_code, m.day, m.decision_volume, m.transfers_per_session, m.guard_rejections_per_turn, m.latency_ms_p95, m.tool_error_rate, m.ask_for_human_rate, JSON.stringify({ metric: "transfers_per_session", sessions: m.sessions, transfers: m.transfers, misses_per_card: m.misses_per_card, time_to_du_findings_ms_p50: m.time_to_du_findings_ms_p50, guard_rejections_per_turn: m.guard_rejections_per_turn })]);
  return m;
}

// ---------------------------------------------------------------- the kill switch (18.1 rule D.5 on the T2 conversation)
export interface KillSwitchEvaluation { readonly tripped: boolean; /** false when the latest breach row was already acted on (the switch stays as the operator left it — a reset is not undone by a re-evaluation; a new breach day trips again) */ readonly applied: boolean; readonly consecutive_breach_days: number; readonly days: readonly { day: string; transfers_per_session: number | null; out_of_band: boolean }[]; readonly band: { low: number; high: number }; readonly flags: readonly string[]; readonly why: string | null }
const outOfBand = (v: number): boolean => v < TRANSFERS_PER_SESSION_BAND.low || v > TRANSFERS_PER_SESSION_BAND.high;
const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
async function setFlag(db: Queryable, key: string, value: boolean, by: string): Promise<void> {
  await db.query(`INSERT INTO feature_flags (key, value, updated_by) VALUES ($1, $2::jsonb, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [key, JSON.stringify(value), by]);
}
export const KILL_SWITCH_FLAGS = (system_code = AI_SYSTEM_CODE): string[] => [...CONVERSATION_AGENTS.map((a) => `${a}.enabled`), `${system_code}.enabled`];
const KILL_SWITCH_WHY = "kill switch: transfers per session";
/**
 * Read the last rows of `ai_monitoring_metrics` up to `day` and trip the switch on KILL_SWITCH_DAYS consecutive calendar days with transfers per
 * session (`escalation_rate`) outside the band — a NULL day (too few sessions) or a gap breaks the run. Tripping: the flags, the registry, the
 * row's `kill_switch_triggered`, the `ai.kill_switch.tripped` event, in one transaction. A row already marked is never acted on again: after the
 * operator's reset the switch stays off until a new breach day lands.
 */
export async function evaluateKillSwitch(runtime: Runtime, i: { day: string; system_code?: string; now?: string }): Promise<KillSwitchEvaluation> {
  const system_code = i.system_code ?? AI_SYSTEM_CODE; const db = runtime.db;
  const rows = await db.query<{ day: string; escalation_rate: string | null; kill_switch_triggered: boolean }>(`SELECT day::text AS day, escalation_rate::text AS escalation_rate, kill_switch_triggered FROM ai_monitoring_metrics WHERE system_code = $1 AND day <= $2::date ORDER BY day DESC LIMIT $3`, [system_code, i.day, KILL_SWITCH_DAYS + 5]);
  const days = rows.slice().reverse().map((r) => ({ day: r.day, transfers_per_session: r.escalation_rate === null ? null : Number(r.escalation_rate), out_of_band: r.escalation_rate !== null && outOfBand(Number(r.escalation_rate)) }));
  let run = 0;
  for (let k = days.length - 1; k >= 0; k--) { const d = days[k]!; if (!d.out_of_band) break; if (k < days.length - 1 && nextDay(d.day) !== days[k + 1]!.day) break; run++; }
  const last = days.at(-1); const tripped = run >= KILL_SWITCH_DAYS;
  const flags = KILL_SWITCH_FLAGS(system_code);
  if (!tripped || !last) return { tripped: false, applied: false, consecutive_breach_days: run, days, band: TRANSFERS_PER_SESSION_BAND, flags, why: null };
  const breached = days.slice(-run);
  const why = `${KILL_SWITCH_WHY} ${breached.map((d) => `${(100 * (d.transfers_per_session ?? 0)).toFixed(1)}% on ${d.day}`).join(", ")} outside [${(100 * TRANSFERS_PER_SESSION_BAND.low).toFixed(0)}%, ${(100 * TRANSFERS_PER_SESSION_BAND.high).toFixed(0)}%] (18.1 rule D.5, 32.16 §3.6)`;
  if (rows[0]?.kill_switch_triggered === true) return { tripped: true, applied: false, consecutive_breach_days: run, days, band: TRANSFERS_PER_SESSION_BAND, flags, why };
  const at = i.now ?? runtime.clock.now();
  await runtime.uow.run({}, (ctx) => ctx.events.append({ type: "ai.kill_switch.tripped", occurredAt: at, actor: { kind: "system", id: "18.1-monitoring" }, aggregate: { kind: "ai_system", id: system_code }, payload: { system_code, metric: "transfers_per_session", band: TRANSFERS_PER_SESSION_BAND, days: breached.map((d) => d.day), values: breached.map((d) => d.transfers_per_session), flags: flags.map((f) => `${f}=false`), human_path: "human_agent" } }), {
    clock: runtime.clock, commit: async (q) => { for (const key of flags) await setFlag(q, key, false, `18.1 kill switch (${system_code})`); await q.query(`UPDATE ai_monitoring_metrics SET kill_switch_triggered = true WHERE system_code = $1 AND day = $2::date`, [system_code, last.day]); },
  });
  for (const agent of CONVERSATION_AGENTS) runtime.agents.tripKillSwitch(agent, why);
  return { tripped: true, applied: true, consecutive_breach_days: run, days, band: TRANSFERS_PER_SESSION_BAND, flags, why };
}
/** The operator's reset (18.1 rule D.5: a human turns the AI path back on): the flags true, the registry's AI-off cleared where this switch set it (an operator's own AI-off or the T1 override switch stays), `ai.kill_switch.reset` logged. */
export async function resetKillSwitch(runtime: Runtime, i: { by: string; system_code?: string; now?: string }): Promise<{ flags: readonly string[] }> {
  const system_code = i.system_code ?? AI_SYSTEM_CODE; const flags = KILL_SWITCH_FLAGS(system_code); const at = i.now ?? runtime.clock.now();
  await runtime.uow.run({}, (ctx) => ctx.events.append({ type: "ai.kill_switch.reset", occurredAt: at, actor: { kind: "human", id: i.by, role: "officer" }, aggregate: { kind: "ai_system", id: system_code }, payload: { system_code, flags: flags.map((f) => `${f}=true`), by: i.by } }), { clock: runtime.clock, commit: async (q) => { for (const key of flags) await setFlag(q, key, true, i.by); } });
  for (const agent of CONVERSATION_AGENTS) if ((runtime.agents.aiState(agent).why ?? "").startsWith(KILL_SWITCH_WHY)) runtime.agents.setAiOff(agent, null);
  return { flags };
}
