/**
 * The typed fetch client for /v1/partner/* through the same-origin proxy at /partners/api (app/api/[...path]/route.ts),
 * which keeps the partner session in an HttpOnly cookie and forwards it as the bearer — the browser never holds a bearer.
 * A 401 (SESSION_EXPIRED, AUTH_REQUIRED) on a session route sends the page back to /partners/sign-in keeping the return path
 * (36.1 rule 6).
 */
import type { DailyReport, ImportListing, ImportResult, PartnerEligibility, PartnerHolds, PartnerHome, PartnerLoanDetail, PartnerMe, PartnerPipeline, PartnerStatus, PartnerUser } from "@/lib/types";

export const BASE_PATH = "/partners";
export const SIGN_IN_PATH = `${BASE_PATH}/sign-in`;
export const apiBase = (): string => `${BASE_PATH}/api`;

export interface ApiError { error?: string; code: string; reason?: string; role?: string; act_as?: string[]; [k: string]: unknown }
export class ApiRequestError extends Error {
  readonly status: number; readonly body: ApiError;
  constructor(status: number, body: ApiError) { super(`${status} ${body.code}`); this.name = "ApiRequestError"; this.status = status; this.body = body; }
}

/** The sign-in door with the page to return to (never the door itself, never another origin). */
export function signInUrl(returnTo: string | null): string {
  const r = returnTo && returnTo.startsWith(BASE_PATH) && !returnTo.startsWith(SIGN_IN_PATH) && !returnTo.startsWith("//") ? `?return=${encodeURIComponent(returnTo)}` : "";
  return `${SIGN_IN_PATH}${r}`;
}
export function returnPathOf(search: string): string {
  const v = new URLSearchParams(search).get("return");
  return v && v.startsWith(BASE_PATH) && !v.startsWith(SIGN_IN_PATH) && !v.startsWith("//") ? v : BASE_PATH;
}
let redirecting = false;
function toSignIn(): void {
  if (typeof window === "undefined" || redirecting) return;
  redirecting = true;
  window.location.assign(signInUrl(`${window.location.pathname}${window.location.search}`));
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown, opts: { door?: boolean; form?: FormData } = {}): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method, credentials: "include",
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: opts.form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  if (!res.ok) {
    let err: ApiError = { code: `HTTP_${res.status}` };
    try { err = (await res.json()) as ApiError; } catch { /* non-JSON error body */ }
    if (res.status === 401 && !opts.door) toSignIn();
    throw new ApiRequestError(res.status, err);
  }
  return (await res.json()) as T;
}

export const api = {
  // the doors (36.1 rule 1): the code, the enrol/step token, the password, the session (its token stays in the proxy cookie)
  authCode: (email: string) => request<{ challenge_id: string; delivery: string; expires_at: string; fake_code?: string }>("POST", "/v1/partner/auth/code", { email }, { door: true }),
  authVerify: (email: string, code: string) => request<{ token: string; expires_at: string; partner_user_id: string; status: string; has_password: boolean; roles: string[] }>("POST", "/v1/partner/auth/verify", { email, code }, { door: true }),
  authPassword: (token: string, password: string) => request<{ partner_user_id: string; enrolled: boolean; status: string }>("POST", "/v1/partner/auth/password", { token, password }, { door: true }),
  authSignIn: (email: string, password: string) => request<{ session: "cookie"; session_id: string; partner_user_id: string; role: string; roles: string[]; expires_at: string; name: string | null }>("POST", "/v1/partner/auth/signin", { email, password }, { door: true }),
  signOut: () => request<{ signed_out: boolean }>("POST", "/v1/partner/auth/signout", {}, { door: true }),
  me: () => request<PartnerMe>("GET", "/v1/partner/me"),
  home: () => request<PartnerHome>("GET", "/v1/partner/home"),
  status: () => request<PartnerStatus>("GET", "/v1/partner/book/status"),
  imports: () => request<{ imports: ImportListing[] }>("GET", "/v1/partner/book/imports"),
  importReport: (id: string) => request<ImportResult & { lines: { loan_id: string; servicer_loan_number: string; change: string; as_of_date: string | null; changed_keys: string[] }[] }>("GET", `/v1/partner/book/imports/${encodeURIComponent(id)}`),
  holds: () => request<PartnerHolds>("GET", "/v1/partner/book/holds"),
  /** 36.2: the one partner write — multipart `as_of_date`, `tape`, `supplement?`; the partner is the session's, never a field. */
  upload: (form: FormData) => request<ImportResult>("POST", "/v1/partner/book/imports", undefined, { form }),
  eligibility: (query = "") => request<PartnerEligibility>("GET", `/v1/partner/eligibility${query}`),
  pipeline: () => request<PartnerPipeline>("GET", "/v1/partner/pipeline"),
  loan: (id: string) => request<PartnerLoanDetail>("GET", `/v1/partner/loans/${encodeURIComponent(id)}`),
  reports: () => request<{ reports: DailyReport[] }>("GET", "/v1/partner/reports/daily"),
  report: (asOf: string) => request<DailyReport>("GET", `/v1/partner/reports/daily?as_of=${encodeURIComponent(asOf)}`),
  /** 36.5 rule 3: the export is a read through the proxy — a link the browser follows with its cookie. */
  exportUrl: (asOf: string, format: "json" | "csv") => `${apiBase()}/v1/partner/reports/daily/export?as_of=${encodeURIComponent(asOf)}&format=${format}`,
  users: () => request<{ users: PartnerUser[] }>("GET", "/v1/partner/users"),
  invite: (body: { email: string; name: string; roles: string[] }) => request<{ partner_user_id: string; status: string; roles: string[] }>("POST", "/v1/partner/users/invite", body),
};
export type Api = typeof api;
