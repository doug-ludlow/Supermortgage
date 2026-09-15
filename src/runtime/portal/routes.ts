/**
 * 34.5 — the portal's read routes (Inputs and triggers), as a table the operator portal's server mounts beside 34.2's
 * (src/console/server.ts, the same dispatch: the session resolved, the role chosen among `roles` — 403 ROLE_REQUIRED before any
 * read — the handler with the staff context, the outcome completing the `staff_actions` row):
 *
 *   GET /ops/api/portal/home?kind=            ops_analyst | officer | compliance | admin   → portal.home     (every staff role; the least-privileged held role acts)
 *   GET /ops/api/directory/list?<filters>     ops_analyst | officer | compliance           → directory.list  (tab, origin, door, status, verified, stage, partner,
 *                                                                                             created_since, created_until, last_seen_since, has_application, has_loan,
 *                                                                                             signed_in_today, sort=newest|last_seen|name, cursor)
 *
 * Every handler runs its tool ON THE BUS (`runtime.execute`, process 34.5) with the session's actor `{kind: human, id: staff_user_id,
 * role}` (34.1 rule 3). The list's query string is a set of filters — an enum, an id, a date — never a name; still, the action log
 * records the list's route as `/ops/api/directory/list?filters_hash=<sha-256 of the canonical filters>` (`logged_query: false`;
 * src/runtime/directory/routes.ts directoryLoggedRoute), the same hash `directory.listed` carries, so one look is one hash in both
 * places and the log never grows a filter text (rule 7, NO_PII_IN_LOG). The answers name the role that acted (`acted_as`).
 */
import type { Runtime } from "../app.ts";
import { DIRECTORY_ROLES } from "../directory/mask.ts";
import { json, type DirectoryRoute, type DirectoryRouteContext, type DirectoryRouteOutcome, type DirectoryStaff } from "../directory/routes.ts";
import { LIST_PATH, LIST_PATH_RE } from "../directory/list.ts";
import { DirectoryRefused } from "../directory/unmask.ts";
import { DirectorySearchRefused } from "../directory/search.ts";
import { CommandRefused } from "../../app/commands.ts";
import { HOME_ROLES, PORTAL_PROCESS } from "./home.ts";
import type { Actor } from "../../kernel/events/index.ts";

export const PORTAL_PATH = "/ops/api/portal";
export { LIST_PATH, LIST_PATH_RE };

const actorOf = (s: DirectoryStaff): Actor => ({ kind: "human", id: s.staff_user_id, role: s.role });
const roleOfMessage = (m: string): string => /requires ([a-z_\/]+)/.exec(m)?.[1]?.split("/")[0] ?? "ops_analyst";
/** The refusal shape (34.2's): `{error, code, ...extra}` with its status — a bus refusal (a guardrail) as 403 / 400 by code. */
function refusal(e: unknown): { status: number; code: string; body: Record<string, unknown> } {
  if (e instanceof DirectoryRefused) return { status: e.status, code: e.code, body: { error: e.message, code: e.code, ...e.extra } };
  if (e instanceof DirectorySearchRefused) return { status: e.code === "QUERY_TOO_SHORT" ? 400 : 422, code: e.code, body: { error: e.message, code: e.code, matches: e.matches } };
  if (e instanceof CommandRefused) { const forbidden = e.code === "ROLE_REQUIRED" || /ROLE|ALLOWLIST|HUMAN_ONLY|AI_OFF|KILL/.test(e.code); return { status: forbidden ? 403 : 400, code: e.code, body: { error: e.message, code: e.code, citation: e.citation, ...(e.code === "ROLE_REQUIRED" ? { role: roleOfMessage(e.message) } : {}) } }; }
  if (e instanceof RangeError) return { status: 400, code: "BAD_REQUEST", body: { error: e.message, code: "BAD_REQUEST" } };
  return { status: 500, code: "ERROR", body: { error: e instanceof Error ? e.message : String(e), code: "ERROR" } };
}

/** The table. `deps.runtime` executes the tools; the server supplies the session (ctx.staff) — nothing here reads a cookie or a header. */
export function portalRoutes(deps: { readonly runtime: Runtime }): DirectoryRoute[] {
  const rt = deps.runtime;
  const run = async (name: string, ctx: DirectoryRouteContext, input: Record<string, unknown>): Promise<Record<string, unknown>> => (await rt.execute({ process: PORTAL_PROCESS, name, loanId: "", actor: actorOf(ctx.staff), input: { ...input, session_id: ctx.staff.session_id } })).output as Record<string, unknown>;
  const roleCheck = (ctx: DirectoryRouteContext, roles: readonly string[]): void => { if (!roles.includes(ctx.staff.role)) throw new DirectoryRefused(403, "ROLE_REQUIRED", `this route needs ${roles.join(" or ")}`, { role: roles[0], held: [...ctx.staff.roles], act_as: roles.filter((r) => ctx.staff.roles.includes(r)) }); };
  const answer = (res: Parameters<DirectoryRoute["handler"]>[1], e: unknown, command: string, subject_kind: DirectoryRouteOutcome["subject_kind"], subject_id: string | null): DirectoryRouteOutcome => { const r = refusal(e); json(res, r.status, r.body); return { status: r.status, command, subject_kind, subject_id, result: r.status >= 500 ? "error" : "refused", refusal_code: r.code }; };

  const home: DirectoryRoute = { method: "GET", path: `${PORTAL_PATH}/home`, pattern: new RegExp(`^${PORTAL_PATH}/home/?$`), roles: HOME_ROLES, command: "portal.home", logged_query: true,
    handler: async (_req, res, ctx) => {
      try { roleCheck(ctx, HOME_ROLES); const out = await run("portal.home", ctx, { kind: ctx.url.searchParams.get("kind") }); json(res, 200, { ...out, acted_as: ctx.staff.role }); return { status: 200, command: "portal.home", subject_kind: "staff_user", subject_id: null, result: "ok" }; }
      catch (e) { return answer(res, e, "portal.home", "staff_user", null); }
    } };
  const list: DirectoryRoute = { method: "GET", path: LIST_PATH, pattern: LIST_PATH_RE, roles: DIRECTORY_ROLES, command: "directory.list", logged_query: false,
    handler: async (_req, res, ctx) => {
      try { roleCheck(ctx, DIRECTORY_ROLES); const out = await run("directory.list", ctx, Object.fromEntries(ctx.url.searchParams)); json(res, 200, { ...out, acted_as: ctx.staff.role }); return { status: 200, command: "directory.list", subject_kind: "list", subject_id: (out["filters_hash"] as string | undefined) ?? null, result: "ok" }; }
      catch (e) { return answer(res, e, "directory.list", "list", null); }
    } };
  return [home, list];
}
