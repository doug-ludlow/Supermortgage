/**
 * Typed fetch client for the 02 §7 API surface.
 *
 * Base URL: NEXT_PUBLIC_API_BASE if set (a host that accepts the borrower session
 * directly), else the same-origin proxy at `/app/api` (app/api/[...path]/route.ts), which
 * keeps the borrower session token in an HttpOnly cookie and forwards it as the bearer —
 * the browser never holds a bearer token of any kind (ops API_TOKEN or session).
 *
 * Routes that exist on the API seam today (src/runtime/server.ts): auth/otp, auth/passkey,
 * auth/l2, identity/stripe/session, me, deeplink/{token}, documents. The rest of 02 §7
 * (record, thread, stream, messages, cards/{id}/resolve, commands, connect, voice) is typed
 * here and answers 404 until the projection/command endpoints land.
 */
import type { AnyCardInstance, ResolveRequest, ResolveResponse, Uuid } from "@/lib/types/cards";
import type { ApiError, BorrowerMe, BorrowerRecord, ThreadMessage } from "@/lib/types/record";
import { subjectId, toMe, toRecord, toThread } from "./adapt";   // 32.13: wire shapes (serialize.ts) → the shell's types

export const BASE_PATH = "/app";

export function apiBase(): string {
  const env = process.env.NEXT_PUBLIC_API_BASE;
  return env && env.length > 0 ? env.replace(/\/$/, "") : `${BASE_PATH}/api`;
}

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiError,
  ) {
    super(`${status} ${body.code}`);
  }
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    credentials: "include",
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...init,
  });
  if (!res.ok) {
    let err: ApiError = { code: `http_${res.status}`, copy_key: "error.generic" };
    try {
      err = (await res.json()) as ApiError;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiRequestError(res.status, err);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** 02 §7 routes, one function each. Paths are relative to /v1/borrower. */
export const api = {
  me: async () => toMe(await request<Record<string, unknown>>("GET", "/v1/borrower/me")),
  record: async (subject: string): Promise<BorrowerRecord> => toRecord(await request<Record<string, unknown>>("GET", `/v1/borrower/record?subject=${encodeURIComponent(subjectId(subject))}`)),
  thread: async (after?: string): Promise<{ messages: ThreadMessage[]; cards: AnyCardInstance[]; next_after?: string }> => toThread(await request<Record<string, unknown>>("GET", `/v1/borrower/thread?limit=500${after ? `&after=${encodeURIComponent(after)}` : ""}`)),
  sendMessage: (body_text: string, subject?: { application_id?: Uuid; loan_id?: Uuid }) => request<{ message: ThreadMessage }>("POST", "/v1/borrower/messages", { text: body_text, ...(subject && (subject.application_id || subject.loan_id) ? { subject: { application_id: subject.application_id ?? null, loan_id: subject.loan_id ?? null } } : {}) }),
  /** Card resolution → mapped command (02 §2); idempotency = card_instance_id. */
  resolveCard: (card_instance_id: Uuid, body: ResolveRequest) =>
    request<ResolveResponse>("POST", `/v1/borrower/cards/${encodeURIComponent(card_instance_id)}/resolve`, body, { headers: { "idempotency-key": card_instance_id } }),
  /** Direct commands not tied to a card: human.request, refi.request, case.open … */
  command: <T = unknown>(name: string, args: Record<string, unknown> = {}) => request<T>("POST", `/v1/borrower/commands/${encodeURIComponent(name)}`, args),
  documentUrl: (document_id: Uuid) => request<{ url: string; expires_at: string }>("GET", `/v1/borrower/documents/${encodeURIComponent(document_id)}`),
  uploadDocument: async (file: File, document_class?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (document_class) form.append("document_class", document_class);
    const res = await fetch(`${apiBase()}/v1/borrower/documents`, { method: "POST", body: form, credentials: "include" });
    if (!res.ok) throw new ApiRequestError(res.status, (await res.json().catch(() => ({ code: "upload_failed", copy_key: "upload.unreadable" }))) as ApiError);
    return (await res.json()) as { document_id: Uuid };
  },
  /** L1 one-time code, two steps (server.ts): request → { challenge_id, delivery, expires_at }; verify → session (token kept in the proxy cookie). */
  authOtpRequest: (channel: "sms" | "email", destination: string) => request<{ challenge_id: string; delivery: "FAKE" | "sms" | "email"; expires_at: string; fake_code?: string }>("POST", "/v1/borrower/auth/otp", { action: "request", channel, destination }),
  authOtpVerify: (challenge_id: string, code: string) => request<{ level: "L1" | "L2" | "L3"; session: "cookie"; expires_at?: string }>("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id, code }),
  authPasskey: (body: { action: "register_options" | "register" | "assert_options" | "assert"; [k: string]: unknown }) => request<Record<string, unknown>>("POST", "/v1/borrower/auth/passkey", body),
  authL2: (ssn_last4: string, date_of_birth: string) => request<{ level: "L2" }>("POST", "/v1/borrower/auth/l2", { ssn_last4, date_of_birth }),
  identitySession: () => request<{ client_secret: string; vendor_session_id: string; card_instance_id: string }>("POST", "/v1/borrower/identity/stripe/session"),
  connectSession: (vendor: string, card_instance_id: Uuid) => request<{ link_token: string; vendor_session_id: string }>("POST", `/v1/borrower/connect/${encodeURIComponent(vendor)}/session`, { card_instance_id }),
  deeplink: (token: string) => request<{ target: { card_instance_id?: Uuid; document_id?: Uuid; route?: string } }>("GET", `/v1/borrower/deeplink/${encodeURIComponent(token)}`),
  voiceSession: () => request<{ token: string }>("POST", "/v1/borrower/voice/session"),
  /** "Talk to a person" — emits human.transfer.requested (01 §1.1). */
  requestHuman: (reason?: string) => request<{ ok: true }>("POST", "/v1/borrower/commands/human.request", { reason }),
};

export type Api = typeof api;
