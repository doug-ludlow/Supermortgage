/**
 * §35.11 rules 5–7 — the daily ops report: one hashed row per environment-day, idempotent by content (REPORT_IS_COUNTS:
 * counts and codes only, nothing summarized by a model), the 18.1 monitoring feed (rule 6) and the FAKE-actor control (rule 7).
 *   assemble   every column of `ops_daily_reports` for (environment, as_of_date) in America/New_York from the tables and events
 *              the Data model lists — an absent feed leaves its column null (edge case 1);
 *   hash       sha256 over the canonical JSON of the columns (types.ts canonicalJson);
 *   append     a row only when no row for the day carries that hash; `ops.report.run_completed{changed}` on every run
 *              (SM_OPS_REPORT_DAILY needs the day's receipt even when nothing changed);
 *   monitor    per bus-agent `ai_systems` row: decisions, overrides, override_rate (decimal, four places, half-up), escalation_rate →
 *              `ai_monitoring_metrics(system_code, day)` upserted; T1 rows → `AgentRegistry.recordOverrideRate`; two consecutive
 *              out-of-band days trip 18.1's switch through `killSwitchEvaluation` (ops-18-1.ts) — the event, the flag, the row;
 *   FAKE       `fake_approvals` / `fake_roles` from `agent_decisions.approved_by` and `loan_events.actor_id` starting `FAKE:`;
 *              under production a count above zero is `ops.fake_in_production` + one exception + one sev1 compliance escalation per day.
 */
import { randomUUID, createHash } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import type { AgentRegistry } from "../../../app/agents.ts";
import { plainDate, addDays, type PlainDate } from "../../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../../kernel/calendar/business.ts";
import { wallClock, zonedEpochMs } from "../../../kernel/calendar/zoned.ts";
import { killSwitchEvaluation, type AiTier } from "../../qc-audit/ops-18-1.ts";
import { EV, openException, type StewardDeps } from "../stewardship.ts";
import { feedsOf, type Feeds } from "./ports.ts";
import { runbookForTimer } from "./runbook.ts";
import { ET, OPS_RULE_SET_VERSION, STEWARD_AGENT, STEWARD_MODEL_VERSION, STEWARD_PROMPT_VERSION, byOf, canonicalJson, isProduction, s, type Row } from "./types.ts";

export interface ReportColumns {
  readonly environment: string; readonly as_of_date: string;
  readonly sweep: Row | null; readonly cycles: Row[] | null; readonly breaches: Row[]; readonly escalations: Row; readonly outbox: Row[]; readonly exceptions: Row;
  readonly fake_approvals: number; readonly fake_roles: string[]; readonly kill_switches: Row[]; readonly projection: Row | null; readonly documents: Row | null; readonly roles: Row | null; readonly override_rates: Row[];
}
export interface DailyReportResult { readonly report_id: string; readonly environment: string; readonly as_of_date: string; readonly produced_on: string; readonly sha256: string; readonly changed: boolean; readonly document_id: string | null; readonly columns: ReportColumns; readonly monitoring: readonly MonitoringRow[]; readonly fake_in_production: { exception_id: string; escalation_id: string | null } | null; readonly feeds: Feeds }
export interface MonitoringRow { readonly system_code: string; readonly risk_tier: string; readonly decisions: number; readonly overrides: number; readonly escalations: number; readonly override_rate: string | null; readonly escalation_rate: string | null; readonly out_of_band: boolean; readonly recorded: boolean; readonly tripped: boolean }

const sha256 = (v: string): string => createHash("sha256").update(v).digest("hex");
/** overrides ÷ decisions as a four-place decimal string, half-up (rule 6: precision 20, four places, half-up); null for a day with zero decisions. */
export function rate4(num: number, den: number): string | null {
  if (den <= 0) return null;
  const scaled = (BigInt(num) * 10_000n * 2n + BigInt(den)) / (2n * BigInt(den));
  const whole = scaled / 10_000n, frac = scaled % 10_000n;
  return `${whole}.${frac.toString().padStart(4, "0")}`;
}
const outOfBand = (r: string | null): boolean => r !== null && (Number(r) < 0.02 || Number(r) > 0.15);
/** Rule 6: a day with zero decisions is the null day (decision_volume 0, a null rate, never out of band); every other day has a rate. */
export const MIN_DECISIONS_PER_DAY = 1;
const n = (v: unknown): number => Number(v ?? 0);

export async function reportRanOn(q: Queryable, environment: string, produced_on: string): Promise<boolean> {
  return (await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE type = $1 AND payload->>'environment' = $2 AND payload->>'produced_on' = $3`, [EV.reportCompleted, environment, produced_on]))[0]!.n !== "0";
}

/** The day's columns (rule 5): counts and codes only. */
export async function assembleReport(q: Queryable, i: { environment: string; as_of_date: string; now: string; feeds: Feeds; agents: AgentRegistry; ports: StewardDeps["ports"] }): Promise<{ columns: ReportColumns; monitoring: MonitoringRow[] }> {
  const day = plainDate(i.as_of_date); const next = addDays(day, 1);
  const from = new Date(zonedEpochMs(day, "00:00", ET)).toISOString(); const to = new Date(zonedEpochMs(next, "00:00", ET)).toISOString();
  const f = i.feeds; const present = (t: keyof Feeds): boolean => f[t] === "present";
  const one = async <T extends Row>(sql: string, p: unknown[]): Promise<T | undefined> => (await q.query<T>(sql, p))[0];
  // sweep (35.1)
  let sweep: Row | null = null;
  if (present("sweep_runs")) { const r = await one(`SELECT count(*)::text AS runs, count(*) FILTER (WHERE outcome = 'completed')::text AS completed, count(*) FILTER (WHERE outcome = 'skipped')::text AS skipped, count(*) FILTER (WHERE outcome = 'failed')::text AS failed, coalesce(max(extract(epoch FROM (finished_at - started_at)) * 1000), 0)::bigint::text AS longest_ms FROM sweep_runs WHERE started_at >= $1::timestamptz AND started_at < $2::timestamptz`, [from, to]); sweep = { runs: n(r?.["runs"]), completed: n(r?.["completed"]), skipped: n(r?.["skipped"]), failed: n(r?.["failed"]), longest_ms: n(r?.["longest_ms"]), heartbeat_ok: n(r?.["completed"]) > 0 }; }
  // cycles (35.3)
  const cycles = present("cycle_registry") ? [...(await i.ports.cycles.daySummary(q, from, to))] : null;
  // breaches: timer.breached in the window, by code, with the registry's owner and severity
  const breaches = (await q.query<{ code: string; count: string }>(`SELECT payload->>'code' AS code, count(*)::text AS count FROM loan_events WHERE type = 'timer.breached' AND occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz GROUP BY payload->>'code' ORDER BY 1`, [from, to])).map((b) => { const rb = runbookForTimer(b.code); return { timer_code: b.code, count: Number(b.count), owner_role: rb?.owner_role ?? null, severity: rb?.severity ?? null }; });
  // escalations
  const openByRole = await q.query<{ role: string; n: string }>(`SELECT coalesce(owner_role, '') AS role, count(*)::text AS n FROM escalations WHERE opened_at < $1::timestamptz AND (completed_at IS NULL OR completed_at >= $1::timestamptz) GROUP BY 1 ORDER BY 1`, [to]);
  const escAgg = await one(`SELECT count(*) FILTER (WHERE opened_at >= $1::timestamptz AND opened_at < $2::timestamptz)::text AS opened_today, count(*) FILTER (WHERE completed_at >= $1::timestamptz AND completed_at < $2::timestamptz)::text AS completed_today, min(opened_at) FILTER (WHERE opened_at < $2::timestamptz AND (completed_at IS NULL OR completed_at >= $2::timestamptz))::text AS oldest_open_at FROM escalations`, [from, to]);
  const escalations: Row = { open_by_role: Object.fromEntries(openByRole.map((r) => [r.role, Number(r.n)])), opened_today: n(escAgg?.["opened_today"]), completed_today: n(escAgg?.["completed_today"]), oldest_open_at: (escAgg?.["oldest_open_at"] as string | null) ?? null };
  // outbox: per adapter (35.1's dispatches, 34.4's hand requeues, this process's automatic ones)
  const outbox: Row[] = present("outbox_dispatches") ? await q.query<Row>(`WITH adapters AS (SELECT DISTINCT adapter FROM integration_messages UNION SELECT DISTINCT adapter FROM outbox_dispatches)
      SELECT a.adapter,
        (SELECT count(*)::int FROM integration_messages m WHERE m.adapter = a.adapter AND m.status = 'queued') AS queued,
        (SELECT count(*)::int FROM outbox_dispatches d WHERE d.adapter = a.adapter AND d.outcome = 'acked' AND d.finished_at >= $1::timestamptz AND d.finished_at < $2::timestamptz) AS sent,
        (SELECT count(*)::int FROM outbox_dispatches d WHERE d.adapter = a.adapter AND d.outcome = 'retry' AND d.finished_at >= $1::timestamptz AND d.finished_at < $2::timestamptz) AS retried,
        (SELECT count(*)::int FROM outbox_dispatches d WHERE d.adapter = a.adapter AND d.outcome IN ('dead', 'fallback') AND d.finished_at >= $1::timestamptz AND d.finished_at < $2::timestamptz) AS dead,
        (SELECT count(*)::int FROM loan_events e WHERE e.type = 'outbox.requeued' AND e.payload->>'adapter' = a.adapter AND e.actor_kind = 'human' AND e.occurred_at >= $1::timestamptz AND e.occurred_at < $2::timestamptz) AS requeued_by_hand,
        (SELECT count(*)::int FROM loan_events e WHERE e.type = 'outbox.requeued' AND e.payload->>'adapter' = a.adapter AND coalesce((e.payload->>'auto')::boolean, false) AND e.occurred_at >= $1::timestamptz AND e.occurred_at < $2::timestamptz) AS requeued_auto
      FROM adapters a ORDER BY a.adapter`, [from, to]) : [];
  // exceptions (this process)
  const exAgg = await one(`SELECT count(*) FILTER (WHERE opened_at >= $1::timestamptz AND opened_at < $2::timestamptz)::text AS opened, count(*) FILTER (WHERE classified_at >= $1::timestamptz AND classified_at < $2::timestamptz)::text AS classified, count(*) FILTER (WHERE assigned_at >= $1::timestamptz AND assigned_at < $2::timestamptz)::text AS assigned, count(*) FILTER (WHERE status = 'resolved' AND resolved_at >= $1::timestamptz AND resolved_at < $2::timestamptz)::text AS resolved, count(*) FILTER (WHERE status = 'abandoned' AND resolved_at >= $1::timestamptz AND resolved_at < $2::timestamptz)::text AS abandoned FROM ops_exceptions WHERE environment = $3`, [from, to, i.environment]);
  const byKind = await q.query<{ kind: string; n: string }>(`SELECT kind, count(*)::text AS n FROM ops_exceptions WHERE environment = $3 AND opened_at >= $1::timestamptz AND opened_at < $2::timestamptz GROUP BY kind ORDER BY kind`, [from, to, i.environment]);
  const bd1 = new Date(zonedEpochMs(addBusinessDays(day, -1, servicer), "23:59", ET)).toISOString();
  const over1bd = await one(`SELECT count(*)::text AS n FROM ops_exceptions WHERE environment = $2 AND status = 'open' AND opened_at <= $1::timestamptz`, [bd1, i.environment]);
  const exceptions: Row = { opened: n(exAgg?.["opened"]), classified: n(exAgg?.["classified"]), by_kind: Object.fromEntries(byKind.map((k) => [k.kind, Number(k.n)])), assigned: n(exAgg?.["assigned"]), resolved: n(exAgg?.["resolved"]), abandoned: n(exAgg?.["abandoned"]), open_over_1bd: n(over1bd?.["n"]) };
  // FAKE actors (rule 7): agent_decisions.approved_by and loan_events.actor_id starting FAKE:
  const fakeDec = await q.query<{ role: string; n: string }>(`SELECT substr(approved_by, 6) AS role, count(*)::text AS n FROM agent_decisions WHERE approved_by LIKE 'FAKE:%' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz GROUP BY 1`, [from, to]);
  const fakeEv = await q.query<{ role: string; n: string }>(`SELECT substr(actor_id, 6) AS role, count(*)::text AS n FROM loan_events WHERE actor_id LIKE 'FAKE:%' AND occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz GROUP BY 1`, [from, to]);
  const fake_approvals = [...fakeDec, ...fakeEv].reduce((a, r) => a + Number(r.n), 0);
  const fake_roles = [...new Set([...fakeDec, ...fakeEv].map((r) => r.role))].sort();
  // kill switches as 34.4 keeps them: the events and the <code>.enabled flags
  const ks = await q.query<{ code: string; type: string; at: string }>(`SELECT DISTINCT ON (payload->>'system_code') payload->>'system_code' AS code, type, occurred_at::text AS at FROM loan_events WHERE type IN ('ai.kill_switch.tripped', 'ai.kill_switch.reset') AND occurred_at < $1::timestamptz ORDER BY payload->>'system_code', sequence DESC`, [to]);
  const flags = present("feature_flags") ? await q.query<{ key: string; value: unknown; at: string }>(`SELECT key, value, updated_at::text AS at FROM feature_flags WHERE key LIKE '%.enabled' AND value = 'false'::jsonb`) : [];
  const kill_switches: Row[] = [...ks.map((k) => ({ code: k.code, state: k.type.endsWith("tripped") ? "tripped" : "reset", since: k.at })), ...flags.filter((fl) => !ks.some((k) => `${k.code}.enabled` === fl.key)).map((fl) => ({ code: fl.key.replace(/\.enabled$/, ""), state: "off", since: fl.at }))].sort((a, b) => String(a["code"]).localeCompare(String(b["code"])));
  // projection (35.1), documents (35.2), roles (35.7)
  const pr = present("projection_runs") ? await one(`SELECT coalesce(sum(gaps), 0)::text AS gaps, coalesce(sum(mismatches), 0)::text AS mismatches FROM projection_runs WHERE finished_at >= $1::timestamptz AND finished_at < $2::timestamptz`, [from, to]) : undefined;
  const projection: Row | null = pr ? { gaps: n(pr["gaps"]), mismatches: n(pr["mismatches"]) } : null;
  let documents: Row | null = null;
  if (present("document_integrity_findings")) { const df = await one(`SELECT count(*)::text AS n FROM document_integrity_findings WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`, [from, to]); const staged = present("document_blobs") ? await one(`SELECT count(*)::text AS n FROM document_blobs WHERE drained_at IS NULL AND staged_at < $1::timestamptz`, [new Date(Date.parse(to) - 86_400_000).toISOString()]).catch(() => undefined) : undefined; documents = { integrity_findings: n(df?.["n"]), staged_over_1d: staged ? n(staged["n"]) : null }; }
  const roles: Row | null = present("role_queue_snapshots") ? { unstaffed: (await q.query<{ role: string }>(`SELECT role FROM (SELECT DISTINCT ON (role) role, status FROM role_queue_snapshots WHERE environment = $1 AND created_at < $2::timestamptz ORDER BY role, created_at DESC, id DESC) t WHERE status = 'unstaffed' ORDER BY role`, [i.environment, to])).map((r) => r.role) } : null;
  // rule 6: the monitoring feed for every ai_systems row that is a bus agent
  const busAgents = new Set(i.agents.agents().map((a) => a.agent));
  const systems = present("ai_systems") ? (await q.query<{ code: string; risk_tier: string }>(`SELECT code, risk_tier FROM ai_systems ORDER BY code`)).filter((r) => busAgents.has(r.code)) : [];
  const monitoring: MonitoringRow[] = [];
  for (const sys of systems) {
    const dec = await one(`SELECT count(*)::text AS decisions,
        count(*) FILTER (WHERE action LIKE '%\\_rejected' OR coalesce(reviewer_action, '') = 'rejected' OR (approved_by IS NOT NULL AND coalesce(outcome, '') IN ('overridden', 'rejected')))::text AS overrides
      FROM agent_decisions d WHERE d.agent = $1 AND d.action NOT LIKE 'ops.report%' AND coalesce((SELECT e.occurred_at FROM loan_events e WHERE e.id = d.event_id), d.created_at) >= $2::timestamptz AND coalesce((SELECT e.occurred_at FROM loan_events e WHERE e.id = d.event_id), d.created_at) < $3::timestamptz`, [sys.code, from, to]);   // the report's own record is not a decision it measures (a re-run would otherwise never be unchanged)
    const work = await one(`SELECT count(*)::text AS n FROM loan_events WHERE type = 'work.action.decided' AND payload->>'decision' = 'rejected' AND payload->>'agent' = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz`, [sys.code, from, to]);
    const escDiff = await one(`SELECT count(*)::text AS n FROM loan_events WHERE type = 'escalation.completed' AND payload->>'agent' = $1 AND payload ? 'proposed_disposition' AND payload->>'disposition' IS DISTINCT FROM payload->>'proposed_disposition' AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz`, [sys.code, from, to]);
    const escOpened = await one(`SELECT count(*)::text AS n FROM loan_events WHERE type = 'escalation.created' AND actor_kind = 'agent' AND actor_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz`, [sys.code, from, to]);
    const decisions = n(dec?.["decisions"]); const overrides = n(dec?.["overrides"]) + n(work?.["n"]) + n(escDiff?.["n"]);
    const override_rate = decisions >= MIN_DECISIONS_PER_DAY ? rate4(overrides, decisions) : null; const escalation_rate = decisions >= MIN_DECISIONS_PER_DAY ? rate4(n(escOpened?.["n"]), decisions) : null;
    monitoring.push({ system_code: sys.code, risk_tier: sys.risk_tier, decisions, overrides, escalations: n(escOpened?.["n"]), override_rate, escalation_rate, out_of_band: outOfBand(override_rate), recorded: false, tripped: false });
  }
  const override_rates: Row[] = monitoring.map((m) => ({ system_code: m.system_code, decisions: m.decisions, overrides: m.overrides, override_rate: m.override_rate, out_of_band: m.out_of_band }));
  return { columns: { environment: i.environment, as_of_date: i.as_of_date, sweep, cycles, breaches, escalations, outbox, exceptions, fake_approvals, fake_roles, kill_switches, projection, documents, roles, override_rates }, monitoring };
}

/** Rule 6's persistence and the 18.1 trip, inside the report's unit of work. */
async function monitor(d: StewardDeps, day: string, rows: MonitoringRow[], agents: AgentRegistry): Promise<MonitoringRow[]> {
  const out: MonitoringRow[] = [];
  for (const m of rows) {
    const prior = (await d.q.query<{ override_rate: string | null; kill_switch_triggered: boolean }>(`SELECT override_rate::text AS override_rate, kill_switch_triggered FROM ai_monitoring_metrics WHERE system_code = $1 AND day = $2::date`, [m.system_code, day]))[0];
    await d.q.query(`INSERT INTO ai_monitoring_metrics (system_code, day, decision_volume, escalation_rate, override_rate) VALUES ($1, $2::date, $3, $4, $5) ON CONFLICT (system_code, day) DO UPDATE SET decision_volume = EXCLUDED.decision_volume, escalation_rate = EXCLUDED.escalation_rate, override_rate = EXCLUDED.override_rate`, [m.system_code, day, m.decisions, m.escalation_rate, m.override_rate]);
    let recorded = false, tripped = false;
    const t1 = m.risk_tier === "T1_consequential";
    // a null day (zero decisions) is never recorded and never counts toward the two; a re-run with the same rate is not a second day
    if (t1 && m.override_rate !== null && (!prior || prior.override_rate === null || Number(prior.override_rate) !== Number(m.override_rate))) {
      recorded = true;
      const r = agents.recordOverrideRate(m.system_code, day, Number(m.override_rate));
      // the persisted evaluation (a fresh process has no memory of yesterday): consecutive non-null days up to this one
      const daily = (await d.q.query<{ day: string; rate: string | null }>(`SELECT day::text AS day, override_rate::text AS rate FROM ai_monitoring_metrics WHERE system_code = $1 AND day <= $2::date ORDER BY day DESC LIMIT 8`, [m.system_code, day])).reverse();
      const series: { day: PlainDate; value: number }[] = [];
      for (const x of daily) { if (x.rate === null) { series.length = 0; continue; } series.push({ day: plainDate(x.day), value: Number(x.rate) }); }
      const ev = killSwitchEvaluation({ system_code: m.system_code, risk_tier: m.risk_tier as AiTier, metric: "override_rate", daily: series });
      // the registry's array has no notion of a day with zero decisions: when the persisted series (the truth) shows the gap broke the run, the registry's trip is undone — a null day never counts toward the two
      if (r.tripped && !ev.tripped) agents.setAiOff(m.system_code, null);
      if (ev.tripped && !prior?.kill_switch_triggered) {
        tripped = true;
        const last2 = series.slice(-2).map((x) => (100 * x.value).toFixed(1) + "%").join(", ");
        const why = `kill switch: override rate ${last2} on ${day} (18.1)`;
        if (!r.tripped) agents.tripKillSwitch(m.system_code, why);
        const evPayload = ev.event ?? { type: "ai.kill_switch.tripped" as const, system_code: m.system_code, metric: "override_rate" as const, days: series.slice(-2).map((x) => x.day), flag: `${m.system_code}.enabled=false` };
        const e = d.events.append({ type: evPayload.type, aggregate: { kind: "ai_system", id: m.system_code }, actor: d.actor, payload: { system_code: evPayload.system_code, metric: evPayload.metric, days: evPayload.days, flag: evPayload.flag, values: series.slice(-2).map((x) => x.value), band: ev.band, human_path: ev.human_path, why } });
        await d.q.query(`INSERT INTO feature_flags (key, value, updated_by) VALUES ($1, 'false'::jsonb, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [`${m.system_code}.enabled`, `18.1 kill switch (35.11 ops report ${day})`]);
        await d.q.query(`UPDATE ai_monitoring_metrics SET kill_switch_triggered = true WHERE system_code = $1 AND day = $2::date`, [m.system_code, day]);
        d.decide({ agent: STEWARD_AGENT, action: "ops.report:kill_switch", rationale: `${why}; ai.kill_switch.tripped{metric: override_rate} through 18.1 rule D.5 (rule_set_version: ${OPS_RULE_SET_VERSION}, model_version: ${STEWARD_MODEL_VERSION}, prompt_version: ${STEWARD_PROMPT_VERSION})`, ruleSetVersion: OPS_RULE_SET_VERSION, subject: { kind: "ai_system", id: m.system_code }, confidence: 1, modelVersion: STEWARD_MODEL_VERSION, promptVersion: STEWARD_PROMPT_VERSION, eventId: e.id });
      }
    }
    out.push({ ...m, recorded, tripped });
  }
  return out;
}

export interface ReportInput { readonly environment: string; readonly as_of_date?: string | null; readonly force?: boolean; readonly produced_by: string; readonly agents: AgentRegistry }
export async function runDailyReport(d: StewardDeps, i: ReportInput): Promise<DailyReportResult> {
  const produced_on = wallClock(Date.parse(d.now), ET).date;
  const as_of_date = i.as_of_date && /^\d{4}-\d{2}-\d{2}$/.test(i.as_of_date) ? i.as_of_date : produced_on;
  const feeds = await feedsOf(d.q);
  const { columns, monitoring } = await assembleReport(d.q, { environment: i.environment, as_of_date, now: d.now, feeds, agents: i.agents, ports: d.ports });
  const json = canonicalJson(columns); const hash = sha256(json);
  const existing = (await d.q.query<{ id: string; document_id: string | null }>(`SELECT id::text AS id, document_id::text AS document_id FROM ops_daily_reports WHERE environment = $1 AND as_of_date = $2::date AND sha256 = $3 ORDER BY created_at DESC LIMIT 1`, [i.environment, as_of_date, hash]))[0];
  let report_id = existing?.id ?? randomUUID(); let document_id = existing?.document_id ?? null; const changed = !existing;
  if (changed) {
    document_id = await d.ports.reportDocument.store(d.q, { report_id, environment: i.environment, as_of_date, sha256: hash, json, now: d.now });
    const c = columns;
    await d.q.query(`INSERT INTO ops_daily_reports (id, environment, as_of_date, produced_on, sweep, cycles, breaches, escalations, outbox, exceptions, fake_approvals, fake_roles, kill_switches, projection, documents, roles, override_rates, sha256, document_id, produced_by, created_at)
      VALUES ($1, $2, $3::date, $4::date, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12::text[], $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18, $19::uuid, $20, $21::timestamptz)`,
      [report_id, c.environment, c.as_of_date, produced_on, c.sweep === null ? null : JSON.stringify(c.sweep), c.cycles === null ? null : JSON.stringify(c.cycles), JSON.stringify(c.breaches), JSON.stringify(c.escalations), JSON.stringify(c.outbox), JSON.stringify(c.exceptions), c.fake_approvals, c.fake_roles, JSON.stringify(c.kill_switches), c.projection === null ? null : JSON.stringify(c.projection), c.documents === null ? null : JSON.stringify(c.documents), c.roles === null ? null : JSON.stringify(c.roles), JSON.stringify(c.override_rates), hash, document_id, i.produced_by, d.now]);
  }
  const ev = d.events.append({ type: EV.reportCompleted, aggregate: { kind: "ops_report", id: i.environment }, actor: d.actor, payload: { report_id, environment: i.environment, as_of_date, produced_on, sha256: hash, changed, produced_by: i.produced_by, fake_approvals: columns.fake_approvals, feeds_absent: Object.entries(feeds).filter(([, v]) => v === "absent").map(([k]) => k) } });
  const monitored = await monitor(d, as_of_date, monitoring, i.agents);
  // rule 7: a FAKE actor in production is a sev-1 control failure — once per day, however many rows
  let fake: DailyReportResult["fake_in_production"] = null;
  // rule 7 keys on the runtime's ENVIRONMENT (35.7's one source), never on the input: a nonprod console asking for "production" opens nothing, a production runtime cannot opt out
  if (isProduction(d.environment) && columns.fake_approvals > 0) {
    const o = await openException(d, { source_kind: "fake_actor", source_id: as_of_date, kind: "fake_in_production", owner_role: "compliance", environment: i.environment, signals: { count: columns.fake_approvals, roles: columns.fake_roles } });
    let escalation_id: string | null = null;
    if (o.created) {
      d.events.append({ type: EV.fakeInProduction, aggregate: { kind: "ops_exception", id: o.exception_id }, actor: d.actor, payload: { environment: i.environment, as_of_date, roles: columns.fake_roles, count: columns.fake_approvals, exception_id: o.exception_id } });
      await d.q.query(`UPDATE ops_exceptions SET status = 'triaged', classified_at = $2::timestamptz, confidence = 1 WHERE id = $1::uuid`, [o.exception_id, d.now]);
      const esc = d.escalations.open({ kind: "sev1", ownerRole: "compliance", severity: "1", payload: { code: "FAKE_IN_PRODUCTION", environment: i.environment, as_of_date, roles: columns.fake_roles, count: columns.fake_approvals, exception_id: o.exception_id, report_id, opened_by: byOf(d.actor) } }, d.actor);
      escalation_id = esc.id;
      d.deferWrite(async (q) => { await q.query(`UPDATE ops_exceptions SET escalation_id = $2::uuid WHERE id = $1::uuid`, [o.exception_id, esc.id]); });
    } else escalation_id = o.row.escalation_id;
    fake = { exception_id: o.exception_id, escalation_id };
  }
  d.decide({ agent: STEWARD_AGENT, action: "ops.report", rationale: `${i.environment} ${as_of_date}: ${changed ? "new row" : "unchanged"} sha256 ${hash}; produced ${produced_on} by ${i.produced_by}; feeds absent: ${Object.entries(feeds).filter(([, v]) => v === "absent").map(([k]) => k).join(", ") || "none"}; fake_approvals ${columns.fake_approvals}${fake ? `; FAKE in production → exception ${fake.exception_id}` : ""} (rule_set_version: ${OPS_RULE_SET_VERSION}, model_version: ${STEWARD_MODEL_VERSION}, prompt_version: ${STEWARD_PROMPT_VERSION})`, ruleSetVersion: OPS_RULE_SET_VERSION, subject: { kind: "ops_report", id: report_id }, confidence: 1, modelVersion: STEWARD_MODEL_VERSION, promptVersion: STEWARD_PROMPT_VERSION, eventId: ev.id });
  return { report_id, environment: i.environment, as_of_date, produced_on, sha256: hash, changed, document_id, columns, monitoring: monitored, fake_in_production: fake, feeds };
}
export const reportSha256 = (columns: ReportColumns): string => sha256(canonicalJson(columns));
export { s };
