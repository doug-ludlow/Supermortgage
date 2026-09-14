/**
 * 34.1 rule 2 — "Roles are the only authority." The four staff roles, the refusals the portal answers before any
 * read (`ROLE_REQUIRED{role}`), and the two invariants every role change obeys: a role is never self-granted
 * (`NO_SELF_ROLE_CHANGE`) and at least one active `admin` always remains (`LAST_ADMIN_STAYS`). Pure functions —
 * the bus tools (src/app/tools/section34-1.ts) and the console (src/console/server.ts) call them; nothing here
 * touches a row.
 *
 *   ops_analyst  reads the directory and the partner-book views, dispatches ops commands (uploads, resolutions,
 *                escalation completion, outbox requeue)
 *   officer      additionally approves what the sections' tools reserve to `officer` (campaign approvals, waivers)
 *   compliance   reads everything including unmasked PII for a case, runs the access review and the evidence pack,
 *                trips or resets the AI kill switch with admin
 *   admin        manages staff users and roles and nothing else that touches a borrower
 */
export const STAFF_ROLES = ["ops_analyst", "officer", "compliance", "admin"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export const isStaffRole = (r: unknown): r is StaffRole => typeof r === "string" && (STAFF_ROLES as readonly string[]).includes(r);

/** The roles the four staff roles may act as on the legacy console routes and the bus (rule 2: admin touches no borrower). */
export const OPS_ROLES: readonly StaffRole[] = ["ops_analyst", "officer", "compliance"];
export const ACCESS_REVIEW_ROLES: readonly StaffRole[] = ["compliance", "admin"];
export const ACCESS_REVIEW_DAYS = 90;

/** A typed refusal the portal answers as JSON `{ error, code, ...extra }` with its status. */
export class StaffError extends Error {
  readonly status: number; readonly code: string; readonly extra: Record<string, unknown>;
  /** The action log's `refusal_code` when the wire answer is deliberately generic (the doors never enumerate accounts: an unknown address, a missing code and a wrong code all answer `OTP_INVALID`; the log keeps the real reason). */
  readonly logCode: string;
  constructor(status: number, code: string, detail?: string, extra: Record<string, unknown> = {}, logCode?: string) { super(detail ?? code); this.name = "StaffError"; this.status = status; this.code = code; this.extra = extra; this.logCode = logCode ?? code; }
}

/** Distinct, valid staff roles from an input array, in the canonical order; throws on an unknown role or an empty set. */
export function normalizeRoles(v: unknown): StaffRole[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const out: StaffRole[] = [];
  for (const r of arr) { if (!isStaffRole(r)) throw new RangeError(`unknown staff role ${String(r)}; roles are ${STAFF_ROLES.join(", ")}`); if (!out.includes(r)) out.push(r); }
  if (!out.length) throw new RangeError("at least one role is required");
  return STAFF_ROLES.filter((r) => out.includes(r));
}
export const sameRoles = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((r) => b.includes(r));

/**
 * Rule 3: the role the request acts under. `preferred` (the request's `x-staff-role` header / `role` field) wins when the
 * user holds it and the route accepts it; else the first of `required` the user holds; else the user's first role when the
 * route accepts any. A route that needs a role the user lacks answers 403 `ROLE_REQUIRED{role}` before any read.
 */
export function chooseRole(held: readonly string[], required: readonly string[] | null, preferred?: string | null): string {
  const accepts = (r: string): boolean => !required || required.includes(r);
  if (preferred) {
    if (!held.includes(preferred)) throw new StaffError(403, "ROLE_REQUIRED", `the session does not hold role ${preferred}`, { role: preferred, held: [...held] });
    if (!accepts(preferred)) throw new StaffError(403, "ROLE_REQUIRED", `this route needs ${required!.join(" or ")}, not ${preferred}`, { role: required![0], held: [...held] });
    return preferred;
  }
  if (!required) { const r = held[0]; if (!r) throw new StaffError(403, "ROLE_REQUIRED", "the account holds no role", { role: "ops_analyst", held: [] }); return r; }
  const r = required.find((x) => held.includes(x));
  if (!r) throw new StaffError(403, "ROLE_REQUIRED", `this route needs ${required.join(" or ")}`, { role: required[0], held: [...held] });
  return r;
}

// ───────── the invariants (rule 2; guardrails NO_SELF_ROLE_CHANGE, LAST_ADMIN_STAYS)
export const NO_SELF_ROLE_CHANGE = { code: "NO_SELF_ROLE_CHANGE", citation: "34.1 rule 2: 'A role is never self-granted: staff.role.set refuses the caller's own row'" } as const;
export const LAST_ADMIN_STAYS = { code: "LAST_ADMIN_STAYS", citation: "34.1 rule 2: 'always keeps at least one active admin'; edge cases: 'Two admins disable each other simultaneously → LAST_ADMIN_STAYS refuses the second'" } as const;
/** The caller's own row: a role change (or a disable) of oneself is refused whatever the roles. */
export const isSelfChange = (actorStaffUserId: string | null | undefined, targetStaffUserId: string): boolean => !!actorStaffUserId && actorStaffUserId === targetStaffUserId;
/**
 * Would the change leave no active admin? `activeAdminIds` are the active users holding admin now; the target's row
 * after the change holds `rolesAfter` (an empty array for a disable).
 */
export function wouldRemoveLastAdmin(activeAdminIds: readonly string[], targetStaffUserId: string, rolesAfter: readonly string[]): boolean {
  if (!activeAdminIds.includes(targetStaffUserId)) return false;
  if (rolesAfter.includes("admin")) return false;
  return activeAdminIds.filter((id) => id !== targetStaffUserId).length === 0;
}

// ───────── the access review (rule 6)
export type ReviewDecision = "keep" | "change" | "disable";
export interface ReviewInput { readonly staff_user_id: string; readonly decision: ReviewDecision; readonly roles?: readonly string[] }
export interface ReviewEntry { readonly staff_user_id: string; readonly roles_before: readonly StaffRole[]; readonly decision: ReviewDecision; readonly roles_after: readonly StaffRole[] }
export interface ReviewPlan { readonly entries: ReviewEntry[]; readonly changes: ReviewEntry[]; readonly missing: string[]; readonly unknown: string[] }
/**
 * Every active user needs a decision (keep | change{roles} | disable); the plan lists what changes (run through
 * staff.role.set / staff.disable by the tool) and refuses nothing itself — `missing` and `unknown` are the caller's to reject.
 */
export function planAccessReview(active: readonly { id: string; roles: readonly string[] }[], decisions: readonly ReviewInput[]): ReviewPlan {
  const byId = new Map(active.map((u) => [u.id, u] as const));
  const entries: ReviewEntry[] = []; const unknown: string[] = [];
  for (const d of decisions) {
    const u = byId.get(d.staff_user_id); if (!u) { unknown.push(d.staff_user_id); continue; }
    const before = normalizeRoles(u.roles.length ? u.roles : ["ops_analyst"]).filter((r) => u.roles.includes(r));
    if (d.decision === "keep") entries.push({ staff_user_id: u.id, roles_before: before, decision: "keep", roles_after: before });
    else if (d.decision === "disable") entries.push({ staff_user_id: u.id, roles_before: before, decision: "disable", roles_after: [] });
    else if (d.decision === "change") { const after = normalizeRoles(d.roles); entries.push({ staff_user_id: u.id, roles_before: before, decision: sameRoles(before, after) ? "keep" : "change", roles_after: after }); }
    else throw new RangeError(`decision for ${d.staff_user_id} must be keep, change or disable`);
  }
  const decided = new Set(entries.map((e) => e.staff_user_id));
  const missing = active.filter((u) => !decided.has(u.id)).map((u) => u.id);
  return { entries, changes: entries.filter((e) => e.decision !== "keep"), missing, unknown };
}
