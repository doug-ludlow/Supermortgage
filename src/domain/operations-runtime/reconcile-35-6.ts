/** §35.6 rule 8 — the three-sided purchase reconciliation (group C). */
import type { Runtime } from "../../runtime/app.ts";
import type { Actor } from "../../kernel/events/index.ts";
export async function reconcilePurchase(_rt: Runtime, applicationId: string, _o: { now: string; actor: Actor }): Promise<Record<string, unknown>> { throw new RangeError(`35.6 orchestration.reconcile is not built yet (application ${applicationId})`); }
