/** §35.6 rule 6 — the hand-off snapshot built from the record (group C). */
import type { Runtime } from "../../runtime/app.ts";
import type { Actor } from "../../kernel/events/index.ts";
export interface SnapshotBuild { readonly snapshot_id: string | null; readonly orchestration_id: string | null; readonly snapshot_hash: string; readonly gaps: readonly string[]; readonly fixture_used: boolean; readonly environment: string; readonly refused_code: string | null; readonly sources: Record<string, unknown> }
export async function buildFundingSnapshot(_rt: Runtime, applicationId: string, _o: { now: string; actor: Actor; persist: boolean }): Promise<SnapshotBuild> { throw new RangeError(`35.6 orchestration.snapshot is not built yet (application ${applicationId})`); }
export async function fundFromSnapshot(_rt: Runtime, applicationId: string, _o: { now: string; actor: Actor; snapshot_id: string | null; overrides: Record<string, unknown> | null }): Promise<Record<string, unknown>> { throw new RangeError(`35.6 orchestration.fund is not built yet (application ${applicationId})`); }
