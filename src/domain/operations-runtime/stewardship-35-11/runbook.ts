/**
 * §35.11 rule 8 — the runbook is generated from the registry, never authored by hand or a model:
 *   {timer_code}  → {code, kind, trigger, anchor, offset, satisfied, breach_text, owner_role, severity, spec_path, process, section}
 *                   from spec/registry/timers.json (the row verbatim) and spec/registry/manifest.json (the owning process's path);
 *   {cycle_code}  → the `cycle_registry` row with its owner and `expected_by_rule` (35.3's table, through the CyclesPort);
 *   {adapter}     → the adapter's retry policy (DEFAULT_RETRY), its last success and its open exceptions.
 * An unknown code is refused UNKNOWN_CODE.
 */
import { readFileSync } from "node:fs";
import type { Queryable } from "../../../infra/db/client.ts";
import { DEFAULT_RETRY } from "../../../infra/integrations/outbox.ts";
import type { StewardPorts } from "./ports.ts";
import { portsOf } from "./ports.ts";
import { EXCEPTION_COLS, type ExceptionRow, type Row } from "./types.ts";

interface TimerRow { code: string; section: number; process: string; kind: string; trigger: string; anchor: string; offset: string; satisfied: string; breach: string }
interface ManifestRow { process: string; path: string; title: string }
let cache: { timers: Map<string, TimerRow>; manifest: Map<string, ManifestRow> } | null = null;
function registry(): NonNullable<typeof cache> {
  if (cache) return cache;
  const timers = JSON.parse(readFileSync(new URL("../../../../spec/registry/timers.json", import.meta.url), "utf8")) as TimerRow[];
  const manifest = JSON.parse(readFileSync(new URL("../../../../spec/registry/manifest.json", import.meta.url), "utf8")) as ManifestRow[];
  cache = { timers: new Map(timers.map((t) => [t.code, t])), manifest: new Map(manifest.map((m) => [m.process, m])) };
  return cache;
}
const strip = (v: string): string => v.replace(/^`|`$/g, "");
const parseBreach = (breach: string): { severity: number | null; owner_role: string | null } => {
  const sev = /sev(?:erity)?\s*[-: ]?\s*([1-4])/i.exec(breach);
  const role = /`([a-z][a-z0-9_]*)`/.exec(breach);
  return { severity: sev ? Number(sev[1]) : null, owner_role: role ? role[1]! : null };
};

export interface TimerRunbook { code: string; kind: string; trigger: string; anchor: string; offset: string; satisfied: string; breach_text: string; owner_role: string | null; severity: number | null; spec_path: string | null; process: string; section: number; title: string | null }
export function runbookForTimer(code: string): TimerRunbook | null {
  const t = registry().timers.get(code); if (!t) return null;
  const m = registry().manifest.get(t.process); const b = parseBreach(t.breach);
  return { code: t.code, kind: t.kind, trigger: strip(t.trigger), anchor: strip(t.anchor), offset: t.offset, satisfied: strip(t.satisfied), breach_text: t.breach, owner_role: b.owner_role, severity: b.severity, spec_path: m ? `spec/${m.path}` : null, process: t.process, section: t.section, title: m?.title ?? null };
}
export async function runbookForCycle(q: Queryable, cycle_code: string, ports?: Partial<Required<StewardPorts>> | StewardPorts): Promise<Row | null> {
  const row = await portsOf(ports).cycles.registryRow(q, cycle_code);
  if (!row) return null;
  const m = row.owner_process ? registry().manifest.get(row.owner_process) : undefined;
  return { cycle_code, owner_process: row.owner_process, owner_agent: row.owner_agent, unit_scope: row.unit_scope, schedule: row.schedule, escalation_role: row.escalation_role ?? "ops_analyst", expected_by_rule: row.expected_by_rule, status: row.status, last_period_key: row.last_period_key, last_receipt_at: row.last_receipt_at, next_period_key: row.next_period_key, next_expected_by: row.next_expected_by, overdue_since: row.overdue_since, spec_path: m ? `spec/${m.path}` : null };
}
export async function runbookForAdapter(q: Queryable, adapter: string): Promise<Row> {
  const last = (await q.query<{ at: string | null }>(`SELECT max(finished_at)::text AS at FROM outbox_dispatches WHERE adapter = $1 AND outcome = 'acked'`, [adapter]))[0]?.at ?? null;
  const open = await q.query<ExceptionRow>(`SELECT ${EXCEPTION_COLS} FROM ops_exceptions WHERE adapter = $1 AND status IN ('open', 'triaged', 'assigned') ORDER BY opened_at`, [adapter]);
  const counts = await q.query<{ status: string; n: string }>(`SELECT status, count(*)::text AS n FROM integration_messages WHERE adapter = $1 GROUP BY status ORDER BY status`, [adapter]);
  return { adapter, retry_policy: { max_attempts: DEFAULT_RETRY.maxAttempts, base_delay_ms: DEFAULT_RETRY.baseDelayMs, max_delay_ms: DEFAULT_RETRY.maxDelayMs }, last_success_at: last, messages_by_status: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])), open_exceptions: open.map((e) => ({ exception_id: e.id, kind: e.kind, status: e.status, source_id: e.source_id, opened_at: e.opened_at, auto_requeues: e.auto_requeues })) };
}
export async function readRunbook(q: Queryable, i: { timer_code?: string | null; cycle_code?: string | null; adapter?: string | null }, ports?: StewardPorts): Promise<{ kind: "timer" | "cycle" | "adapter"; runbook: Row } | { refused: "UNKNOWN_CODE"; reason: string }> {
  if (i.timer_code) { const r = runbookForTimer(i.timer_code); return r ? { kind: "timer", runbook: r as unknown as Row } : { refused: "UNKNOWN_CODE", reason: `no registry timer ${i.timer_code} (spec/registry/timers.json)` }; }
  if (i.cycle_code) { const r = await runbookForCycle(q, i.cycle_code, ports); return r ? { kind: "cycle", runbook: r } : { refused: "UNKNOWN_CODE", reason: `no cycle_registry row ${i.cycle_code}` }; }
  if (i.adapter) { const known = (await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM integration_messages WHERE adapter = $1`, [i.adapter]))[0]!.n !== "0" || (await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM outbox_dispatches WHERE adapter = $1`, [i.adapter]))[0]!.n !== "0"; return known ? { kind: "adapter", runbook: await runbookForAdapter(q, i.adapter) } : { refused: "UNKNOWN_CODE", reason: `no outbox adapter ${i.adapter}` }; }
  return { refused: "UNKNOWN_CODE", reason: "ops.runbook.read needs one of timer_code, cycle_code or adapter" };
}
