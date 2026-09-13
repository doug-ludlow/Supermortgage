"use client";

/**
 * 32.17 discrepancy (3) — the FAKE video agent's page: what FakeTavus hands out as `conversation_url` (/app/video/fake/{token}?vs=…),
 * embedded by the call pane where the vendor's Daily room would be. A `FAKE video agent` marker, a text box and the browser's own
 * speech recognition when it has one; every utterance is posted as the same OpenAI chat-completions request the vendor would send
 * (POST /v1/video/llm/{token}/chat/completions, `stream: true`, the last user message the utterance) and the streamed reply is shown —
 * and spoken by speechSynthesis when available — as the replica's words. On open it triggers the same `system.replica_joined`
 * callback the vendor would; its own Leave triggers `system.shutdown`. It never sends conversation.echo or conversation.respond.
 *
 * The brain is the endpoint: nothing here decides a word. The page holds the per-session video token (the vendor would hold the same),
 * never the app session — the join/leave helper rides on the proxy's session cookie.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fakeVideoCallback, videoChat } from "@/lib/api/video";
import { ApiRequestError } from "@/lib/api/client";
import { copy } from "@/lib/copy";

type Recognition = { start(): void; stop(): void; lang: string; interimResults: boolean; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };
type RecognitionCtor = new () => Recognition;
const recognitionCtor = (): RecognitionCtor | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};
type Line = { role: "you" | "replica"; text: string; at: string; id: number };
let seq = 0;

export function FakeVideoPage({ token, videoSessionId }: { token: string; videoSessionId: string | null }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  const [left, setLeft] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef<Recognition | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const canListen = recognitionCtor() !== null;

  // the vendor's callback on open: system.replica_joined (through the API's FAKE helper → the same handler the vendor's HTTP callback runs)
  useEffect(() => {
    if (!videoSessionId) return;
    fakeVideoCallback(videoSessionId, "system.replica_joined", { fake: true }).then(() => setJoined(true)).catch(() => setJoined(false));
  }, [videoSessionId]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: "end" }); }, [lines.length]);

  const speak = useCallback((t: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window) || !t) return;
    try { window.speechSynthesis.speak(new SpeechSynthesisUtterance(t)); } catch { /* no voice: the words are on the page */ }
  }, []);

  const send = useCallback(async (t?: string) => {
    const msg = (t ?? text).trim();
    if (!msg || busy || left) return;
    setBusy(true); setError(null); setText("");
    const youId = (seq += 1); const replicaId = (seq += 1);
    setLines((cur) => [...cur, { role: "you", text: msg, at: new Date().toISOString(), id: youId }, { role: "replica", text: "", at: new Date().toISOString(), id: replicaId }]);
    try {
      const whole = await videoChat(token, msg, (piece) => setLines((cur) => cur.map((l) => (l.id === replicaId ? { ...l, text: l.text + piece } : l))));
      speak(whole);
    } catch (e) {
      const code = e instanceof ApiRequestError ? e.status : 0;
      setError(code === 401 ? copy("video.ended") : copy("error.generic"));
      setLines((cur) => cur.filter((l) => l.id !== replicaId));
    } finally { setBusy(false); }
  }, [text, busy, left, token, speak]);

  const listen = useCallback(() => {
    const Ctor = recognitionCtor(); if (!Ctor || listening) return;
    const rec = new Ctor(); rec.lang = "en-US"; rec.interimResults = false;
    rec.onresult = (e) => { const heard = Array.from(e.results).map((r) => r[0]?.transcript ?? "").join(" ").trim(); if (heard) void send(heard); };
    rec.onend = () => setListening(false); rec.onerror = () => setListening(false);
    recRef.current = rec; setListening(true); rec.start();
  }, [listening, send]);

  const leave = useCallback(async () => {
    setLeft(true);
    if (videoSessionId) await fakeVideoCallback(videoSessionId, "system.shutdown", { shutdown_reason: "participant_left" }).catch(() => undefined);
  }, [videoSessionId]);

  return (
    <div className="sm-fake-video" data-testid="fake-video-page" data-joined={joined ? "true" : "false"} data-left={left ? "true" : "false"}>
      <div className="sm-video-bar">
        <span className="sm-fake-banner" data-testid="fake-video-marker">{copy("video.fake.marker")}</span>
        <span className="sm-header-spacer" />
        {!left ? (
          <button type="button" className="sm-btn sm-btn-quiet" data-testid="fake-video-leave" onClick={() => void leave()}>
            {copy("video.leave")}
          </button>
        ) : null}
      </div>
      <div className="sm-fake-video-log" role="log" aria-label="What the video agent says" data-testid="fake-video-log">
        {lines.map((l) => (
          <p key={l.id} className={`sm-fake-video-line sm-fake-video-${l.role}`} data-testid={l.role === "replica" ? "fake-video-replica" : "fake-video-you"} data-role={l.role}>
            {l.text || (l.role === "replica" ? "…" : "")}
          </p>
        ))}
        <div ref={endRef} />
      </div>
      {error ? (
        <p className="sm-error" role="status" data-testid="fake-video-error">{error}</p>
      ) : null}
      {left ? (
        <p className="sm-muted" data-testid="fake-video-left">{copy("video.ended")}</p>
      ) : (
        <form className="sm-fake-video-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <label className="sm-visually-hidden" htmlFor="fake-video-input">{copy("video.fake.input")}</label>
          <input id="fake-video-input" className="sm-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={listening ? "Listening…" : copy("video.fake.input")} autoComplete="off" disabled={busy} data-testid="fake-video-input" />
          {canListen ? (
            <button type="button" className="sm-btn" onClick={listen} disabled={busy || listening} aria-pressed={listening} data-testid="fake-video-listen">
              {copy("video.fake.listen")}
            </button>
          ) : null}
          <button type="submit" className="sm-btn sm-btn-primary" disabled={busy || !text.trim()} data-testid="fake-video-send">
            {copy("video.fake.send")}
          </button>
        </form>
      )}
    </div>
  );
}
