/**
 * The cookie proxy's allow-list (docs/partner-portal/00-CLAUDE-BUILD-INSTRUCTIONS.md §6): only `/v1/partner/*` on the API
 * origin is reachable through /partners/api; `/v1/partner-book/*` (the staff / machine path), `/ops` and `/v1/borrower/*`
 * never are. Pure, so the unit suite can pin it; app/api/[...path]/route.ts is the only caller.
 */
export const ALLOWED_PREFIX = "v1/partner/";
/** Named for the record, though the prefix test alone already refuses each (none starts with `v1/partner/`). */
export const DENIED_PREFIXES: readonly string[] = ["v1/partner-book/", "ops", "ops/", "v1/borrower/", "v1/video/"];
/** The API answers a session on these and nowhere else: the answer's `token` becomes the HttpOnly cookie and never reaches the browser. */
export const SESSION_ROUTES: ReadonlySet<string> = new Set(["v1/partner/auth/signin", "v1/partner/auth/passkey/assert"]);
export const SIGN_OUT_ROUTE = "v1/partner/auth/signout";
export const SESSION_COOKIE = "sm_partner_session";
export const COOKIE_PATH = "/partners";
/** The API enforces the real expiry (30 minutes idle, 12 hours absolute — 36.1 rule 6); the cookie lives no longer than the absolute limit. */
export const SESSION_MAX_AGE_S = 12 * 3600;

/** The path segments of a proxied request, joined — allowed only under `/v1/partner/`, with no empty or dot segment. */
export function upstreamPathAllowed(segments: readonly string[]): boolean {
  if (!segments.length || segments.some((s) => s === "" || s === "." || s === ".." || s.includes("\\") || s.includes("/"))) return false;
  const joined = segments.join("/");
  if (DENIED_PREFIXES.some((p) => joined === p.replace(/\/$/, "") || joined.startsWith(p))) return false;
  return joined.startsWith(ALLOWED_PREFIX) && joined.length > ALLOWED_PREFIX.length;
}

/** The Set-Cookie value for a session: HttpOnly, Secure in production (or over https), SameSite=Lax, Path=/partners. */
export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${SESSION_MAX_AGE_S}`;
}
export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=0`;
}
