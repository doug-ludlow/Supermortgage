/**
 * 32.16 §2.0 (DELTA-29) — e-mail + password accounts over the same-origin proxy: `POST /v1/borrower/auth/account {action}`.
 * The proxy lists the route in AUTH_ROUTES, so a session answer's `token` becomes the HttpOnly cookie and the browser sees
 * `{level, session: "cookie", party, expires_at}` only. Refusals are `{code, copy_key}` → `copy(copy_key)`; the sign-in
 * refusal `EMAIL_UNVERIFIED` also carries `challenge_id` (a fresh code was sent) so the app can show the code step.
 *
 * `request()` in ./client.ts is module-private, so this file carries its own POST over `apiBase()`.
 */
import type { ApiError } from "@/lib/types/record";
import { apiBase, ApiRequestError } from "./client";

export const ACCOUNT_PATH = "/v1/borrower/auth/account";

export type AccountSession = { level: "L1" | "L2" | "L3"; session: "cookie"; expires_at?: string; party?: { party_id: string; first_name?: string; display_name?: string } };
export type AccountChallenge = { challenge_id: string; delivery: "FAKE" | "email"; expires_at: string; fake_code?: string };
/** `EMAIL_UNVERIFIED` (403): the refusal body also names the fresh challenge. */
export type AccountErrorBody = ApiError & { challenge_id?: string; fake_code?: string };

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${apiBase()}${ACCOUNT_PATH}`, {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let err: AccountErrorBody = { code: `http_${res.status}`, copy_key: "error.generic" };
    try {
      err = (await res.json()) as AccountErrorBody;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiRequestError(res.status, err);
  }
  return (await res.json()) as T;
}

/** Create: a six-digit code goes to the e-mail. 409 `ACCOUNT_EXISTS` (account.exists) · 400 `PASSWORD_WEAK` (account.password_weak). */
export const accountCreate = (email: string, password: string) => post<AccountChallenge>({ action: "create", email, password });
/** The code verifies the e-mail and opens the L1 session. 401 `OTP_INVALID` / `OTP_EXPIRED` · 429 `OTP_TOO_MANY_ATTEMPTS`. */
export const accountVerifyEmail = (challenge_id: string, code: string) => post<AccountSession>({ action: "verify_email", challenge_id, code });
/** 401 `PASSWORD_WRONG` · 423 `ACCOUNT_LOCKED` · 403 `EMAIL_UNVERIFIED` (+ `challenge_id`, `fake_code?`). */
export const accountSignIn = (email: string, password: string) => post<AccountSession>({ action: "sign_in", email, password });
/** Always ok (no account enumeration); the challenge is named when a code was sent. */
export const accountRequestReset = (email: string) => post<{ ok: true; challenge_id?: string; fake_code?: string }>({ action: "request_reset", email });
/** The reset code plus the new password; no session is opened — the borrower signs in next. */
export const accountReset = (challenge_id: string, code: string, password: string) => post<{ ok: true }>({ action: "reset", challenge_id, code, password });

/** The extra fields an `EMAIL_UNVERIFIED` refusal carries, if any. */
export function challengeOf(e: unknown): { challenge_id: string; fake_code?: string } | undefined {
  if (!(e instanceof ApiRequestError)) return undefined;
  const b = e.body as AccountErrorBody;
  return typeof b.challenge_id === "string" && b.challenge_id ? { challenge_id: b.challenge_id, ...(b.fake_code ? { fake_code: b.fake_code } : {}) } : undefined;
}
