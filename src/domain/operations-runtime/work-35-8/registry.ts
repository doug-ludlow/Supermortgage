/**
 * §35.8 — the registered screens (`work_screen_versions`, rule 1 / rule 10): at registration each action of the catalogue
 * (screens.ts) is snapshotted with the roles copied from the tool's `humanRoles` (the bus default when the tool declares
 * none: ops_analyst + officer + the process's escalation roles — src/console/server.ts toolRoles), the tool's `moneyFields`
 * (`tool_money_fields`) and the catalogue's `money` flag; a new version is written only when the snapshot differs from the
 * current one. The daily reconciliation (recon.ts) recomputes the snapshot against the registry now loaded: a screen whose
 * roles or money fields moved is stale — its actions are `available: false, needs: re-registration` until `registerScreens`
 * writes version + 1 (T12), and `work.screen.act` answers SCREEN_STALE{code, version}.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import { canonicalJson } from "../../../app/canonical.ts";
import { loadAgentsFile } from "../../../app/agents.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { SCREENS, type ActionSpec, type ScreenSpec } from "./screens.ts";
import { PROCESS_35_8, type Row } from "./types.ts";

export interface RegisteredAction { readonly code: string; readonly process: string; readonly tool: string; readonly op: string | null; readonly roles: readonly string[]; readonly tool_money_fields: readonly string[]; readonly money: boolean; readonly decision_schema: Row; readonly derived_fields: readonly string[]; readonly deriver: string; readonly deriver_version: string; readonly registered: boolean }
export interface ScreenVersion { readonly id: string; readonly code: string; readonly version: number; readonly subject_kind: string; readonly owning_process: string; readonly read_tools: readonly string[]; readonly actions: readonly RegisteredAction[]; readonly registered_at: string }

let escalatesTo: Map<string, readonly string[]> | null = null;
const DEFAULT_HUMAN_ROLES = ["ops_analyst", "officer"];
/** The roles a bus tool admits on the human path (src/app/tools.ts toolCommand's default, as the console computes it). */
export function toolRoles(rt: Runtime, process: string, name: string): { roles: readonly string[]; money_fields: readonly string[]; registered: boolean } {
  const def = rt.tool(process, name);
  if (!def) return { roles: [], money_fields: [], registered: false };
  if (def.humanRoles) return { roles: [...def.humanRoles], money_fields: [...(def.moneyFields ?? [])], registered: true };
  escalatesTo ??= new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  return { roles: [...new Set([...DEFAULT_HUMAN_ROLES, ...(escalatesTo.get(process) ?? [])])], money_fields: [...(def.moneyFields ?? [])], registered: true };
}
/** The snapshot of one catalogue action against the registry now loaded. */
export function snapshotAction(rt: Runtime, a: ActionSpec): RegisteredAction {
  const t = toolRoles(rt, a.process, a.tool);
  const roles = a.needs ? t.roles.filter((r) => a.needs!.includes(r)) : t.roles;
  return { code: a.code, process: a.process, tool: a.tool, op: a.op ?? null, roles, tool_money_fields: t.money_fields, money: a.money, decision_schema: a.decision_schema as unknown as Row, derived_fields: a.derived_fields, deriver: a.deriver, deriver_version: a.deriver_version, registered: t.registered };
}
export const snapshotScreen = (rt: Runtime, sc: ScreenSpec): RegisteredAction[] => sc.actions.map((a) => snapshotAction(rt, a));

const rowToVersion = (r: Row): ScreenVersion => ({ id: String(r["id"]), code: String(r["code"]), version: Number(r["version"]), subject_kind: String(r["subject_kind"]), owning_process: String(r["owning_process"]), read_tools: (r["read_tools"] as string[]) ?? [], actions: (r["actions"] as RegisteredAction[]) ?? [], registered_at: String(r["registered_at"]) });
/** The current (highest) version of one screen, or null before registration. */
export async function currentScreen(q: Queryable, code: string): Promise<ScreenVersion | null> {
  const [r] = await q.query<Row>(`SELECT id::text AS id, code, version, subject_kind, owning_process, read_tools, actions, registered_at::text AS registered_at FROM work_screen_versions WHERE code = $1 ORDER BY version DESC LIMIT 1`, [code]);
  return r ? rowToVersion(r) : null;
}
export async function currentScreens(q: Queryable): Promise<ScreenVersion[]> {
  return (await q.query<Row>(`SELECT DISTINCT ON (code) id::text AS id, code, version, subject_kind, owning_process, read_tools, actions, registered_at::text AS registered_at FROM work_screen_versions ORDER BY code, version DESC`)).map(rowToVersion);
}
/** The comparable part of a snapshot (rule 10: roles and money fields; the catalogue's own fields too, so a catalogue change re-registers). */
const comparable = (actions: readonly RegisteredAction[]): string => canonicalJson(actions.map((a) => ({ code: a.code, process: a.process, tool: a.tool, op: a.op, roles: [...a.roles].sort(), tool_money_fields: [...a.tool_money_fields].sort(), money: a.money, decision_schema: a.decision_schema, derived_fields: a.derived_fields, deriver: a.deriver, deriver_version: a.deriver_version })));
/** Is the current version stale against the registry now loaded (rule 10)? */
export function isStale(rt: Runtime, v: ScreenVersion): boolean {
  const sc = SCREENS.find((x) => x.code === v.code); if (!sc) return true;
  return comparable(v.actions) !== comparable(snapshotScreen(rt, sc));
}
/** Register every catalogue screen: a version + 1 row where the snapshot differs (or none exists). Returns the codes written. */
export async function registerScreens(rt: Runtime, q: Queryable, now: string): Promise<{ written: string[]; current: ScreenVersion[] }> {
  const written: string[] = [];
  for (const sc of SCREENS) {
    const cur = await currentScreen(q, sc.code);
    const actions = snapshotScreen(rt, sc);
    if (cur && comparable(cur.actions) === comparable(actions)) continue;
    await q.query(`INSERT INTO work_screen_versions (code, version, subject_kind, owning_process, read_tools, actions, registered_at) VALUES ($1, $2, $3, $4, $5::text[], $6::jsonb, $7::timestamptz)`, [sc.code, (cur?.version ?? 0) + 1, sc.subject_kind, sc.owning_process, [...sc.read_tools], toJson(actions), now]);
    written.push(sc.code);
  }
  return { written, current: await currentScreens(q) };
}
export const REGISTRY_PROCESS = PROCESS_35_8;
