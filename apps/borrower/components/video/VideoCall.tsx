"use client";

/**
 * 32.17 — the call pane: the thread's place on /app/video. It asks for the camera and microphone first (a refusal never blocks
 * the call — the vendor's own room asks again, and the thread at /app is always there), opens the session through the API
 * (POST /v1/borrower/video/sessions → the persona with the custom LLM and the conversation at the vendor or the FAKE), and embeds
 * `conversation_url` — a Daily room on the live vendor, the FAKE page (/app/video/fake/{token}) on FakeTavus — in an iframe with
 * camera, microphone and autoplay allowed. Nothing else: no composer, no microphone control of Supermortgage's own (the call has
 * its own), no "Talk to a person" (32.16 §1 principle 8), no card component (the rail is the rail). The page never sends
 * conversation.echo or conversation.respond: the brain is the endpoint, never the page.
 *
 * `Leave` ends the session (POST …/end); an ended or timed-out call (`max_call_duration`) shows `video.ended` with the rail still
 * live and offers a new call; a vendor outage (`status = failed`) shows `video.unavailable` and the way to the conversation.
 * Fixtures mode (NEXT_PUBLIC_FIXTURES=1) renders a FAKE call with no API behind it, so the layout can be demoed and tested.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "@/lib/api/client";
import { endVideoSession, openVideoSession, videoSession, type VideoSession } from "@/lib/api/video";
import { copy } from "@/lib/copy";
import { SHOW_FAKE_MARKERS } from "@/lib/env";

export type VideoCallProps = {
  fixturesMode: boolean;
  /** The SSE stream's `video.session.*` events bump this; the pane re-reads its status. */
  statusTick?: number;
  onSession?: (s: VideoSession | null) => void;
};

type Phase = "idle" | "permissions" | "opening" | "live" | "ended" | "failed";
export const IFRAME_ALLOW = "camera; microphone; autoplay; display-capture";

/** The FAKE page is the app's own route: same origin as this page, whatever base the API named. */
export function frameSrc(s: VideoSession): string {
  if (!s.conversation_url) return "";
  if (s.vendor === "FAKE") { try { const u = new URL(s.conversation_url, typeof window === "undefined" ? "http://localhost" : window.location.origin); return `${u.pathname}${u.search}`; } catch { return s.conversation_url; } }
  return s.conversation_url;
}

export function VideoCall({ fixturesMode, statusTick, onSession }: VideoCallProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState<VideoSession | null>(null);
  const [permissionNote, setPermissionNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const opening = useRef(false);

  const start = useCallback(async () => {
    if (opening.current) return;
    opening.current = true;
    setError(null); setPermissionNote(null);
    setPhase("permissions");
    if (fixturesMode) {
      // FAKE fixtures mode: no API — a recorded call so the screen can be demoed (the layout, the rail, the footer)
      const fake: VideoSession = { video_session_id: "FAKE-video-session", status: "joined", vendor: "FAKE", conversation_url: null, end_reason: null, transcript_ref: null, created_at: new Date().toISOString(), joined_at: new Date().toISOString(), ended_at: null, subject: {}, conversation_id: "conv-1", replica_id: "r_FAKE_stock", borrower_camera: "on" };
      setSession(fake); onSession?.(fake); setPhase("live"); opening.current = false;
      return;
    }
    // the camera for presence, the microphone for the words (32.17 open question 2: VIDEO_BORROWER_CAMERA=off joins audio-only — the API says which)
    try {
      if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        for (const t of stream.getTracks()) t.stop();   // the room takes its own tracks; nothing of the borrower's camera is kept here
      }
    } catch {
      setPermissionNote(copy("video.permission_denied"));
    }
    setPhase("opening");
    try {
      const s = await openVideoSession();
      setSession(s); onSession?.(s);
      setPhase(s.status === "failed" ? "failed" : "live");
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 503) { setPhase("failed"); }
      else { setError(e instanceof ApiRequestError ? copy(e.body.copy_key) : copy("error.generic")); setPhase("failed"); }
    } finally { opening.current = false; }
  }, [fixturesMode, onSession]);

  useEffect(() => { void start(); }, [start, attempt]);

  // the stream said the session changed (joined, ended by the vendor, max_call_duration): re-read it
  useEffect(() => {
    if (fixturesMode || !session || !statusTick) return;
    let cancelled = false;
    videoSession(session.video_session_id).then((s) => { if (cancelled) return; setSession(s); onSession?.(s); if (s.status === "ended") setPhase("ended"); if (s.status === "failed") setPhase("failed"); }).catch(() => undefined);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusTick]);

  const leave = useCallback(async () => {
    if (!session) return;
    if (fixturesMode) { const ended = { ...session, status: "ended" as const, end_reason: "borrower_left", ended_at: new Date().toISOString() }; setSession(ended); onSession?.(ended); setPhase("ended"); return; }
    try { const s = await endVideoSession(session.video_session_id); setSession(s); onSession?.(s); }
    catch { /* the row is the truth: re-read below */ }
    setPhase("ended");
  }, [session, fixturesMode, onSession]);

  const src = session ? frameSrc(session) : "";
  return (
    <section className="sm-video-pane" data-testid="video-call" data-phase={phase} data-vendor={session?.vendor} aria-label="Video call">
      <div className="sm-video-bar">
        <span className="sm-primary-text" data-testid="video-title">{copy("video.title")}</span>
        {session?.vendor === "FAKE" && SHOW_FAKE_MARKERS ? <span className="sm-fake-banner" data-testid="video-fake-marker">{copy("video.fake.marker")}</span> : null}
        <span className="sm-header-spacer" />
        {phase === "live" ? (
          <button type="button" className="sm-btn sm-btn-quiet" data-testid="video-leave" onClick={() => void leave()}>
            {copy("video.leave")}
          </button>
        ) : null}
      </div>
      <div className="sm-video-stage">
        {phase === "permissions" || phase === "opening" ? (
          <p className="sm-muted" data-testid="video-status">{copy("video.starting")}</p>
        ) : null}
        {phase === "live" && session ? (
          fixturesMode || !src ? (
            <div className="sm-video-frame sm-fake-video" data-testid="video-frame-fake">
              <p className="sm-primary-text">{copy("video.fake.marker")}</p>
              <p className="sm-muted">FAKE fixtures mode — no video agent is connected; the rail beside this pane is the recorded record.</p>
            </div>
          ) : (
            <iframe className="sm-video-frame" data-testid="video-frame" title="Video agent" src={src} allow={IFRAME_ALLOW} />
          )
        ) : null}
        {phase === "ended" ? (
          <div className="sm-video-notice" data-testid="video-ended">
            <p>{copy("video.ended")}</p>
            <button type="button" className="sm-btn sm-btn-primary" data-testid="video-new-call" onClick={() => setAttempt((a) => a + 1)}>
              {copy("video.new_call")}
            </button>
          </div>
        ) : null}
        {phase === "failed" ? (
          <div className="sm-video-notice" data-testid="video-unavailable">
            <p>{error ?? copy("video.unavailable")}</p>
            <a className="sm-btn sm-btn-primary" href="/app" data-testid="video-continue-thread">{copy("video.continue_in_thread")}</a>
          </div>
        ) : null}
        {permissionNote ? <p className="sm-muted" data-testid="video-permission-note">{permissionNote}</p> : null}
      </div>
    </section>
  );
}
