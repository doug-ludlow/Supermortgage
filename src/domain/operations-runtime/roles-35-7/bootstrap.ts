/**
 * §35.7 — the nonprod bootstrap of the owner's own account (owner decision Q2 of 34.5's open questions: for testing, the
 * owner's staff account is granted every role the platform can grant to one person, reviewer roles included, with the FAKE
 * confirmers FAKE:admin and FAKE:compliance on nonprod). Every grant goes through the real `roles.grant` / confirm path on the
 * bus with the actors {human, FAKE:admin, admin} (granting) and {human, FAKE:compliance, compliance} (confirming), so
 * NO_SELF_ROLE_CHANGE, CONFIRMER_IS_HOLDER and the distinct confirmer hold literally and every row and decision says FAKE
 * (`cause = bootstrap_nonprod`, granted_by / confirmed_by NULL). The disjointness matrix is respected: a role whose pair the
 * account already holds is skipped (with `officer` in roles, qc_officer and funding_approver are skipped; of
 * mlo_of_record / underwriting_reviewer the first in HUMAN_ROLES order wins). Refused outright in production
 * (NO_FAKE_IN_PRODUCTION). Called by src/runtime/main.ts after 34.1's staff-bootstrap when STAFF_BOOTSTRAP_REVIEWER_ROLES is set.
 */
import { HUMAN_ROLES } from "../../../app/roles.ts";
import type { Runtime } from "../../../runtime/app.ts";
import type { Logger } from "../../../runtime/log.ts";
import { PgStaffRepository, emailHash } from "../../../runtime/staff/repo.ts";
import { FAKE_ADMIN, FAKE_COMPLIANCE } from "./actors.ts";
import { conflictsWith } from "./matrix.ts";
import { RolesRefused } from "./refusals.ts";
import { INDEPENDENCE_ROLES, PROCESS_35_7, STAFF_WORDS, isProduction } from "./types.ts";

export interface BootstrapReviewerRolesResult { readonly staff_user_id: string | null; readonly granted: readonly string[]; readonly skipped: readonly { role: string; reason: string }[]; readonly reason: string }
export function reviewerRolesSetting(setting: string | readonly string[] | null | undefined): readonly string[] {
  if (setting === undefined || setting === null) return [];
  const raw = typeof setting === "string" ? setting.split(",").map((x) => x.trim()).filter(Boolean) : [...setting];
  if (raw.length === 1 && raw[0] === "all") return HUMAN_ROLES.filter((r) => !STAFF_WORDS.includes(r));
  return raw.filter((r) => (HUMAN_ROLES as readonly string[]).includes(r) && !STAFF_WORDS.includes(r));
}
export async function bootstrapReviewerRoles(rt: Runtime, email: string, o: { roles: string | readonly string[] | null | undefined; logger?: Logger }): Promise<BootstrapReviewerRolesResult> {
  if (isProduction(rt.environment)) throw new RolesRefused(409, "NO_FAKE_IN_PRODUCTION", "the reviewer-role bootstrap with FAKE confirmers exists outside production only (35.7 rule 6; 34.5 decision Q2)", {});
  const wanted = reviewerRolesSetting(o.roles);
  const repo = new PgStaffRepository(rt.db);
  const user = await repo.userByEmailHash(emailHash(email));
  if (!user) return { staff_user_id: null, granted: [], skipped: [], reason: "no staff user for the bootstrap e-mail" };
  if (user.status !== "active") return { staff_user_id: user.id, granted: [], skipped: [], reason: `the account is ${user.status}; enrol first` };
  const granted: string[] = []; const skipped: { role: string; reason: string }[] = [];
  for (const role of wanted) {
    const fresh = (await repo.user(user.id))!; const held = [...fresh.roles, ...fresh.reviewer_roles];
    if (held.includes(role)) { skipped.push({ role, reason: "already held" }); continue; }
    const conflicts = conflictsWith(role, held);
    if (conflicts.length) { skipped.push({ role, reason: `ROLE_DISJOINT with ${conflicts.join(", ")}` }); continue; }
    try {
      const r = await rt.execute({ process: PROCESS_35_7, name: "roles.grant", loanId: "", actor: FAKE_ADMIN, input: { staff_user_id: user.id, role, rationale: "nonprod bootstrap: the owner's account holds every grantable role (34.5 decision Q2)" } });
      const out = r.output as { status: string; request_id: string | null };
      if (out.status === "pending" && out.request_id && INDEPENDENCE_ROLES.includes(role)) await rt.execute({ process: PROCESS_35_7, name: "roles.grant", loanId: "", actor: FAKE_COMPLIANCE, input: { op: "confirm", request_id: out.request_id } });
      granted.push(role);
    } catch (e) { skipped.push({ role, reason: e instanceof Error ? e.message : String(e) }); }
  }
  o.logger?.info("35.7 reviewer-role bootstrap (nonprod)", { staff_user_id: user.id, granted, skipped });
  return { staff_user_id: user.id, granted, skipped, reason: granted.length ? "granted" : "nothing to grant" };
}
