/** §35.7 — the latest role_queue_snapshots row per (environment, role): what a grant reads to know whether the role was `unstaffed` (rule 5's `role.staffed{cause: grant}`). */
import type { Queryable } from "../../../infra/db/client.ts";

export interface SnapshotRow { readonly id: string; readonly scan_run_id: string; readonly environment: string; readonly as_of_date: string; readonly role: string; readonly open_items: number; readonly oldest_opened_at: string | null; readonly holders: number; readonly holders_signed_in_30d: number; readonly fake: boolean; readonly status: "staffed" | "fake" | "unstaffed" | "idle"; readonly created_at: string }
const COLS = `id::text AS id, scan_run_id::text AS scan_run_id, environment, as_of_date::text AS as_of_date, role, open_items, oldest_opened_at::text AS oldest_opened_at, holders, holders_signed_in_30d, fake, status, created_at::text AS created_at`;
export async function latestSnapshot(q: Queryable, environment: string, role: string): Promise<SnapshotRow | undefined> {
  return (await q.query<SnapshotRow & Record<string, unknown>>(`SELECT ${COLS} FROM role_queue_snapshots WHERE environment = $1 AND role = $2 ORDER BY created_at DESC, id DESC LIMIT 1`, [environment, role]))[0];
}
export async function latestSnapshots(q: Queryable, environment: string): Promise<Map<string, SnapshotRow>> {
  const rows = await q.query<SnapshotRow & Record<string, unknown>>(`SELECT DISTINCT ON (role) ${COLS} FROM role_queue_snapshots WHERE environment = $1 ORDER BY role, created_at DESC, id DESC`, [environment]);
  return new Map(rows.map((r) => [r.role, r]));
}
export const roleQueueAggregate = (environment: string, role: string): { kind: string; id: string } => ({ kind: "role_queue", id: `${environment}:${role}` });
