/**
 * SSE client for GET /v1/borrower/stream (02 §3). Frames are
 * `{event_name, at, subject, payload_ref}`; the shell re-fetches the affected
 * projection on each one. Reconnects with capped backoff (UX-6 performance budget).
 */
import { apiBase } from "./client";
import type { StreamEvent } from "@/lib/types/record";

export type StreamHandler = (event: StreamEvent) => void;
export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export type StreamHandle = { close: () => void; status: () => StreamStatus };

/** `named`: SSE frames carry `event: <name>` (src/runtime/borrower/stream.ts), which EventSource delivers to a listener of that name, never to `onmessage` — a page that wants them lists them (32.17: the video shell follows card.sent and video.session.*). */
export function openStream(onEvent: StreamHandler, onStatus?: (s: StreamStatus) => void, named: readonly string[] = []): StreamHandle {
  let source: EventSource | null = null;
  let status: StreamStatus = "connecting";
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const set = (s: StreamStatus) => {
    status = s;
    onStatus?.(s);
  };

  const connect = () => {
    if (closed || typeof EventSource === "undefined") return;
    set(attempt === 0 ? "connecting" : "reconnecting");
    source = new EventSource(`${apiBase()}/v1/borrower/stream`, { withCredentials: true });
    source.onopen = () => {
      attempt = 0;
      set("open");
    };
    const deliver = (m: MessageEvent) => {
      try {
        onEvent(JSON.parse(m.data) as StreamEvent);
      } catch {
        /* malformed frame: ignore, the next projection fetch heals */
      }
    };
    source.onmessage = deliver;
    for (const name of named) source.addEventListener(name, deliver as EventListener);
    source.onerror = () => {
      source?.close();
      source = null;
      if (closed) return;
      attempt += 1;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      set("reconnecting");
      timer = setTimeout(connect, delay);
    };
  };

  connect();
  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      source?.close();
      set("closed");
    },
    status: () => status,
  };
}
