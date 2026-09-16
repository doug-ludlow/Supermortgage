/**
 * §35.7 — `role.exercised{grant_id, staff_user_id, role, command, subject}`: the first commit under a grant (rule 9; the
 * satisfier of SM_ROLE_GRANT_DORMANT_30D). Appended by the surfaces after the command committed, in its own GLOBAL unit of
 * work — a loan-scoped command's transaction hydrates only the loan's timers, and the dormant clock lives on the
 * `role_grant` aggregate with no loan — once per grant (a later act appends nothing). If the process dies between the two
 * transactions the exercise is recorded on the next act.
 */
import type { Runtime } from "../../../runtime/app.ts";
import type { Actor } from "../../../kernel/events/index.ts";
import { grantAggregate, latestGrant } from "./grants.ts";
import { P } from "./types.ts";

export interface ExerciseInput { readonly staff_user_id: string; readonly role: string; readonly environment: string; readonly command: string; readonly subject: { kind: string; id: string } | null; readonly actor: Actor }
export async function recordExercise(rt: Runtime, i: ExerciseInput): Promise<{ recorded: boolean; grant_id: string | null }> {
  const g = await latestGrant(rt.db, i.staff_user_id, i.role, i.environment);
  if (!g || (g.action !== "grant" && g.action !== "breakglass")) return { recorded: false, grant_id: null };
  const prior = await rt.db.query(`SELECT 1 FROM loan_events WHERE type = 'role.exercised' AND payload->>'grant_id' = $1 LIMIT 1`, [g.id]);
  if (prior.length) return { recorded: false, grant_id: g.id };
  await rt.uow.run({}, (ctx) => ctx.events.append({ type: "role.exercised", aggregate: grantAggregate(g.id), actor: i.actor, payload: P({ grant_id: g.id, staff_user_id: i.staff_user_id, role: i.role, environment: i.environment, command: i.command, subject: i.subject, exercised_at: ctx.clock.now() }) }), { clock: rt.clock });
  return { recorded: true, grant_id: g.id };
}
