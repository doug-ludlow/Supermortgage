/**
 * §35.7 rule 6 — the FAKE set is per environment and empty in production. The environment's default is FAKE_REVIEWER_ROLES
 * (the six) when INTEGRATIONS = fake and FAKE_REVIEWERS ≠ off, else ∅; ENVIRONMENT = production forces ∅ whatever the other
 * two say (NO_FAKE_IN_PRODUCTION). The current set is the default minus the roles whose latest role_handovers row in the
 * environment is `enabled` (a later `reverted` row restores) — read from Postgres by the reviewers' tick, the console's queue
 * marking, the queue scan and the board, so 1..N instances and the sweep job agree.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import { FAKE_REVIEWER_ROLES } from "../../../infra/integrations/reviewers.ts";
import { isProduction } from "./types.ts";

export type FakeReason = "NO_FAKE_IN_PRODUCTION" | "FAKE_REVIEWERS_OFF" | "INTEGRATIONS_NOT_FAKE" | null;
export interface FakeDefault { readonly roles: readonly string[]; readonly reason: FakeReason }

/** The environment's default FAKE set and, when it is empty, why (the board shows the reason). */
export function envDefault(env: NodeJS.ProcessEnv = process.env, environment: string | undefined = env["ENVIRONMENT"]): FakeDefault {
  if (isProduction(environment)) return { roles: [], reason: "NO_FAKE_IN_PRODUCTION" };
  if ((env["FAKE_REVIEWERS"] ?? "").trim().toLowerCase() === "off") return { roles: [], reason: "FAKE_REVIEWERS_OFF" };
  if ((env["INTEGRATIONS"] ?? "fake") !== "fake") return { roles: [], reason: "INTEGRATIONS_NOT_FAKE" };
  return { roles: FAKE_REVIEWER_ROLES, reason: null };
}
/** The roles whose latest handover row in the environment is `enabled` — the FAKE stopped filling them — with the instant. */
export async function enabledHandovers(q: Queryable, environment: string): Promise<Map<string, string>> {
  const rows = await q.query<{ role: string; action: string; effective_at: string }>(`SELECT DISTINCT ON (role) role, action, effective_at::text AS effective_at FROM role_handovers WHERE environment = $1 AND action IN ('enabled', 'reverted') ORDER BY role, created_at DESC, id DESC`, [environment]);
  const out = new Map<string, string>();
  for (const r of rows) if (r.action === "enabled") out.set(r.role, r.effective_at);
  return out;
}
/** Rule 6: the current FAKE set of an environment = the default minus the roles handed over to a person. */
export async function currentFakeSet(q: Queryable, environment: string, defaultRoles: readonly string[]): Promise<readonly string[]> {
  if (!defaultRoles.length) return [];
  const enabled = await enabledHandovers(q, environment);
  return defaultRoles.filter((r) => !enabled.has(r));
}
