/**
 * 36.1 rule 2 — "Roles are the only authority, and they are not staff roles." The three partner roles, the refusal the
 * portal answers before any write (`ROLE_REQUIRED{role, held, act_as}`) and the one declared order of rule 3. Pure
 * functions — the partner routes (./routes.ts) and the bus tool (src/app/tools/section36-1.ts) call them; nothing here
 * touches a row. The `chooseRole` pattern of src/runtime/staff/roles.ts is COPIED here with the three partner roles only —
 * never imported with the staff roles in it (rule 3), and no partner role is ever `ops_analyst`, `officer`, `compliance` or
 * `admin` (rule 2).
 *
 *   partner_ops      reads the book, eligibility, the pipeline, the loan page and home; acts on nothing in V1
 *   partner_auditor  reads home, eligibility, the pipeline, reports and loan pages (no upload, no admin); exports the daily report
 *   partner_admin    reads everything in the tenant; acts: book.import (36.2), partner.user.invite, the daily report export (36.5)
 */
export const PARTNER_ROLES = ["partner_ops", "partner_auditor", "partner_admin"] as const;
export type PartnerRole = (typeof PARTNER_ROLES)[number];
export const isPartnerRole = (r: unknown): r is PartnerRole => typeof r === "string" && (PARTNER_ROLES as readonly string[]).includes(r);
/** Rule 3's one declared order, least-privileged first: `partner_ops < partner_auditor < partner_admin`. */
export const ROLE_ORDER: readonly PartnerRole[] = ["partner_ops", "partner_auditor", "partner_admin"];
/** The roles that read a loan page, the book, eligibility, the pipeline and home (rule 2: all three). */
export const READ_ROLES: readonly PartnerRole[] = ["partner_ops", "partner_auditor", "partner_admin"];
/** The roles of the Admin area and of the one partner write (rule 2: `partner_admin` only). */
export const ADMIN_ROLES: readonly PartnerRole[] = ["partner_admin"];
export const EXPORT_ROLES: readonly PartnerRole[] = ["partner_auditor", "partner_admin"];

/** A typed refusal the partner API answers as JSON `{ error, code, ...extra }` with its status — the shape of 34.1's StaffError, its own class. */
export class PartnerError extends Error {
  readonly status: number; readonly code: string; readonly extra: Record<string, unknown>;
  /** The action log's `refusal_code` when the wire answer is deliberately generic (the doors never enumerate accounts: an unknown address, a disabled account, a missing code and a wrong code all answer the same code; the log keeps the real reason). */
  readonly logCode: string;
  constructor(status: number, code: string, detail?: string, extra: Record<string, unknown> = {}, logCode?: string) { super(detail ?? code); this.name = "PartnerError"; this.status = status; this.code = code; this.extra = extra; this.logCode = logCode ?? code; }
}

/** Distinct, valid partner roles from an input array, in the canonical order; throws on an unknown role or an empty set. */
export function normalizePartnerRoles(v: unknown): PartnerRole[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const out: PartnerRole[] = [];
  for (const r of arr) { if (!isPartnerRole(r)) throw new RangeError(`unknown partner role ${String(r)}; roles are ${PARTNER_ROLES.join(", ")} (never a staff role)`); if (!out.includes(r)) out.push(r); }
  if (!out.length) throw new RangeError("at least one partner role is required");
  return ROLE_ORDER.filter((r) => out.includes(r));
}
export const sameRoles = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((r) => b.includes(r));
/** The session's default acting role (rule 3): the least-privileged role the user holds. */
export const defaultRole = (held: readonly string[]): PartnerRole | null => ROLE_ORDER.find((r) => held.includes(r)) ?? null;

/** Rule 3: a `read` (GET) may fall back to another held role; an `act` (POST) never substitutes one — it answers the `act_as` offer. */
export type RoleMode = "read" | "act";
/** The accepted roles the account holds, least-privileged first (rule 3's `act_as` offer and the read fallback's order). */
export function actAsOffer(held: readonly string[], required: readonly string[] | null): string[] {
  const accepts = (r: string): boolean => !required || required.includes(r);
  return ROLE_ORDER.filter((r) => held.includes(r) && accepts(r));
}
/**
 * Rule 3: the role the request acts under — the role returned is `acted_as`. `preferred` (the body's `role` / `?role=` — "Act
 * as") wins when the account holds it and the route accepts it. When the account holds it but the route does not accept it: a
 * `read` acts as the least-privileged accepted role the account holds and the answer names it (`acted_as`); an `act` is refused
 * 403 `ROLE_REQUIRED{role, held, act_as: [the accepted roles the account holds]}` before any write — intent on an act is chosen,
 * never inferred. A role the account does not hold is refused on either method (`act_as: []`), as is a route none of the held
 * roles opens. With no preference, a `read` acts as the least-privileged accepted held role; an `act` is asked for under the
 * session's default role (the least-privileged held role) and is refused the same way when the route does not accept it
 * (36.1-T2: a `partner_ops` session's POST /v1/partner/book/imports is 403 ROLE_REQUIRED with `act_as: []`).
 */
export function chooseRole(held: readonly string[], required: readonly string[] | null, preferred?: string | null, opts: { readonly mode?: RoleMode } = {}): string {
  const mode: RoleMode = opts.mode ?? "act";
  const accepts = (r: string): boolean => !required || required.includes(r);
  const offer = actAsOffer(held, required);
  const asked = preferred || (mode === "act" ? defaultRole(held) : null);
  if (asked) {
    if (!held.includes(asked)) throw new PartnerError(403, "ROLE_REQUIRED", `the session does not hold role ${asked}`, { role: asked, held: [...held], act_as: [] });
    if (accepts(asked)) return asked;
    if (mode === "read" && offer.length) return offer[0]!;
    throw new PartnerError(403, "ROLE_REQUIRED", `this route needs ${required!.join(" or ")}, not ${asked}${offer.length ? `; act as ${offer.join(" or ")}` : ""}`, { role: required![0], held: [...held], act_as: offer });
  }
  if (offer.length) return offer[0]!;
  if (!required) throw new PartnerError(403, "ROLE_REQUIRED", "the account holds no role", { role: "partner_ops", held: [], act_as: [] });
  throw new PartnerError(403, "ROLE_REQUIRED", `this route needs ${required.join(" or ")}`, { role: required[0], held: [...held], act_as: [] });
}

// ───────── the invariants (rule 2; guardrails NO_SELF_ROLE_CHANGE — 34.1's, reused)
export const NO_SELF_ROLE_CHANGE = { code: "NO_SELF_ROLE_CHANGE", citation: "36.1 rule 2: 'A role is never self-granted: partner.user.invite refuses the caller's own e-mail'" } as const;
