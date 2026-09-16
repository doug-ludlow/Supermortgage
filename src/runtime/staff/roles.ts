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
 * Rule 3's one declared order, least-privileged first (amended 2026-09-15, the portal proposal §3): the role a `GET` falls
 * back to is the first of these the route accepts and the account holds — never the route's own first role, which would be
 * privilege used because it is held, not because the function needs it (23 NYCRR 500.7(a)(3)).
 */
export const ROLE_ORDER: readonly StaffRole[] = ["ops_analyst", "officer", "compliance", "admin"];
/** Rule 3: a `read` (GET) may fall back to another held role; an `act` (POST / PUT / DELETE) never substitutes one — it answers the `act_as` offer. */
export type RoleMode = "read" | "act";
/**
 * The accepted roles the account holds, least-privileged first (rule 3's `act_as` offer and the read fallback's order):
 * the staff four in ROLE_ORDER, then any other accepted role the account holds (a tool's own human roles) in the account's order.
 */
export function actAsOffer(held: readonly string[], required: readonly string[] | null): string[] {
  const accepts = (r: string): boolean => !required || required.includes(r);
  return [...ROLE_ORDER.filter((r) => held.includes(r) && accepts(r)), ...held.filter((r) => accepts(r) && !(ROLE_ORDER as readonly string[]).includes(r))];
}
/**
 * Rule 3: the role the request acts under — the role returned is `acted_as`. `preferred` (the request's `x-staff-role` header /
 * `role` field / `?role=` — the header's "Act as") wins when the account holds it and the route accepts it. When the account
 * holds it but the route does not accept it: a `read` acts as the least-privileged accepted role the account holds (the order
 * above) and the caller reports it as `acted_as`; an `act` is refused 403 `ROLE_REQUIRED{role, held, act_as: [the accepted
 * roles the account holds]}` before any write — intent on an act is chosen, never inferred. A role the account does not hold
 * is refused on either method (`act_as: []`), as is a route none of the held roles opens. With no preference, a `read` acts as the
 * least-privileged accepted held role; an `act` is asked for under the session's default role — the least-privileged role it holds,
 * the one `/api/me` reports (`actAsOffer(held, null)[0]`) — and is refused the same way when the route does not accept it: intent on
 * an act is chosen, never inferred, so a header-less client never runs under a greater held authority. `mode` defaults to `act`
 * (no substitution unless the caller says it is a read).
 */
export function chooseRole(held: readonly string[], required: readonly string[] | null, preferred?: string | null, opts: { readonly mode?: RoleMode } = {}): string {
  const mode: RoleMode = opts.mode ?? "act";
  const accepts = (r: string): boolean => !required || required.includes(r);
  const offer = actAsOffer(held, required);
  // an act naming no role is asked for under the session's default role (the least-privileged held role, the one /api/me reports) — never an inferred greater one
  const asked = preferred || (mode === "act" ? actAsOffer(held, null)[0] ?? null : null);
  if (asked) {
    if (!held.includes(asked)) throw new StaffError(403, "ROLE_REQUIRED", `the session does not hold role ${asked}`, { role: asked, held: [...held], act_as: [] });
    if (accepts(asked)) return asked;
    if (mode === "read" && offer.length) return offer[0]!;
    throw new StaffError(403, "ROLE_REQUIRED", `this route needs ${required!.join(" or ")}, not ${asked}${offer.length ? `; act as ${offer.join(" or ")}` : ""}`, { role: required![0], held: [...held], act_as: offer });
  }
  if (offer.length) return offer[0]!;
  if (!required) throw new StaffError(403, "ROLE_REQUIRED", "the account holds no role", { role: "ops_analyst", held: [], act_as: [] });
  throw new StaffError(403, "ROLE_REQUIRED", `this route needs ${required.join(" or ")}`, { role: required[0], held: [...held], act_as: [] });
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
/** 35.7 rule 9: `rationale` (a keep on a user with a dormant grant must name the grant — DORMANT_GRANT_NEEDS_RATIONALE) and `reviewer_roles` (a change that drops one revokes the grant with cause access_review). */
export interface ReviewInput { readonly staff_user_id: string; readonly decision: ReviewDecision; readonly roles?: readonly string[]; readonly rationale?: string | null; readonly reviewer_roles?: readonly string[] }
export interface ReviewEntry { readonly staff_user_id: string; readonly roles_before: readonly StaffRole[]; readonly decision: ReviewDecision; readonly roles_after: readonly StaffRole[]; readonly rationale?: string | null; readonly reviewer_roles?: readonly string[] }
export interface ReviewPlan { readonly entries: ReviewEntry[]; readonly changes: ReviewEntry[]; readonly missing: string[]; readonly unknown: string[] }
/**
 * Every active user needs a decision (keep | change{roles} | disable); the plan lists what changes (run through
 * staff.role.set / staff.disable by the tool) and refuses nothing itself — `missing` and `unknown` are the caller's to reject.
 */
export function planAccessReview(active: readonly { id: string; roles: readonly string[]; reviewer_roles?: readonly string[] }[], decisions: readonly ReviewInput[]): ReviewPlan {
  const byId = new Map(active.map((u) => [u.id, u] as const));
  const entries: ReviewEntry[] = []; const unknown: string[] = [];
  for (const d of decisions) {
    const u = byId.get(d.staff_user_id); if (!u) { unknown.push(d.staff_user_id); continue; }
    const before = normalizeRoles(u.roles.length ? u.roles : ["ops_analyst"]).filter((r) => u.roles.includes(r));
    // 35.7 rule 9: the entry records the reviewer roles the decision names, else the ones the person holds (35.7 T11: the review names the grant kept)
    const explicit = Array.isArray(d.reviewer_roles);
    const extra = { ...(typeof d.rationale === "string" && d.rationale.trim() ? { rationale: d.rationale.trim() } : {}), ...(explicit ? { reviewer_roles: [...d.reviewer_roles!].map(String) } : u.reviewer_roles?.length ? { reviewer_roles: [...u.reviewer_roles] } : {}) };
    if (d.decision === "keep") entries.push({ staff_user_id: u.id, roles_before: before, decision: "keep", roles_after: before, ...extra });
    else if (d.decision === "disable") entries.push({ staff_user_id: u.id, roles_before: before, decision: "disable", roles_after: [], ...extra });
    else if (d.decision === "change") { const after = normalizeRoles(d.roles ?? before); entries.push({ staff_user_id: u.id, roles_before: before, decision: sameRoles(before, after) && !explicit ? "keep" : "change", roles_after: after, ...extra }); }
    else throw new RangeError(`decision for ${d.staff_user_id} must be keep, change or disable`);
  }
  const decided = new Set(entries.map((e) => e.staff_user_id));
  const missing = active.filter((u) => !decided.has(u.id)).map((u) => u.id);
  return { entries, changes: entries.filter((e) => e.decision !== "keep"), missing, unknown };
}
