/**
 * 32.17 — the video agent's API (src/runtime/borrower/video-routes.ts) as the page uses it:
 *   openVideoSession   POST /v1/borrower/video/sessions              → { video_session_id, conversation_url, status, vendor, … }
 *   videoSession       GET  /v1/borrower/video/sessions/{id}         → the current row (status, end_reason, …)
 *   endVideoSession    POST /v1/borrower/video/sessions/{id}/end     → { status: ended }
 *   fakeVideoCallback  POST /v1/borrower/video/sessions/{id}/fake-callback   FAKE only: the FAKE page's join / leave → the same callback path
 *   videoChat          POST /v1/video/llm/{token}/chat/completions   the FAKE page's utterance as the vendor's own chat-completions request
 *                      (stream: true); the reply's chunks are read as they arrive and handed to `onDelta`; resolves to the whole text
 * The session token never reaches the browser: the proxy cookie carries it; the video token in the FAKE page's URL is the
 * per-session bearer the vendor would hold (32.17 rule 6), never the app session.
 */
import { apiBase, ApiRequestError } from "./client";
import type { ApiError } from "@/lib/types/record";

export type VideoStatus = "created" | "joined" | "ended" | "failed";
export type VideoSession = {
  video_session_id: string;
  status: VideoStatus;
  vendor: "tavus" | "FAKE";
  conversation_url: string | null;
  end_reason: string | null;
  transcript_ref: string | null;
  created_at: string;
  joined_at: string | null;
  ended_at: string | null;
  subject: { application_id?: string | null; loan_id?: string | null };
  conversation_id: string;
  replica_id: string | null;
  borrower_camera: "on" | "off";
  /** The greeting the replica speaks first (the guarded first turn, rendered) — on the open response only. */
  greeting?: string;
  fallback_copy_key?: string;
};

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, { method, credentials: "include", headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    let err: ApiError = { code: `http_${res.status}`, copy_key: "error.generic" };
    try { err = (await res.json()) as ApiError; } catch { /* non-JSON error body */ }
    throw new ApiRequestError(res.status, err);
  }
  return (await res.json()) as T;
}

export const openVideoSession = (): Promise<VideoSession> => request<VideoSession>("POST", "/v1/borrower/video/sessions", {});
export const videoSession = (id: string): Promise<VideoSession> => request<VideoSession>("GET", `/v1/borrower/video/sessions/${encodeURIComponent(id)}`);
export const endVideoSession = (id: string, reason = "borrower_left"): Promise<VideoSession> => request<VideoSession>("POST", `/v1/borrower/video/sessions/${encodeURIComponent(id)}/end`, { reason });
export const fakeVideoCallback = (id: string, event_type: "system.replica_joined" | "system.shutdown" | "application.transcription_ready", properties: Record<string, unknown> = {}): Promise<{ received: boolean; outcome?: string }> =>
  request<{ received: boolean; outcome?: string }>("POST", `/v1/borrower/video/sessions/${encodeURIComponent(id)}/fake-callback`, { event_type, properties });

/** The vendor's chat-completions request, verbatim in shape: the last user message is the utterance; the reply streams as chat.completion.chunk events ending in [DONE]. */
export async function videoChat(token: string, text: string, onDelta: (text: string) => void, history: { role: "user" | "assistant"; content: string }[] = []): Promise<string> {
  const res = await fetch(`${apiBase()}/v1/video/llm/${encodeURIComponent(token)}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "supermortgage-turn", stream: true, messages: [...history, { role: "user", content: text }] }),
  });
  if (!res.ok || !res.body) throw new ApiRequestError(res.status, { code: `http_${res.status}`, copy_key: "error.generic" });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let whole = "";
  let done = false;
  while (!done) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { done = true; break; }
      try {
        const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
        const piece = chunk.choices?.[0]?.delta?.content ?? "";
        if (piece) { whole += piece; onDelta(piece); }
      } catch { /* a malformed chunk: skip it */ }
    }
  }
  return whole;
}
