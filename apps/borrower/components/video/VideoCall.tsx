"use client";

/**
 * 32.17 — the call pane: the thread's place on /app/video. It asks for the camera and microphone (a refusal never blocks
 * the call — the vendor's own room asks again, and the thread at /app is always there) while it opens the session through the API
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
import { joinOptionsFor } from "@/lib/video/join";
import { LiveCall } from "./LiveCall";

export type VideoCallProps = {
  fixturesMode: boolean;
  /** The borrower's first name when one is on file — the display name the room sees (32.17 rule 15); "You" otherwise. */
  firstName?: string | null | undefined;
  /** The SSE stream's `video.session.*` events bump this; the pane re-reads its status. */
  statusTick?: number;
  onSession?: (s: VideoSession | null) => void;
};

type Phase = "idle" | "opening" | "live" | "ended" | "failed";
export const IFRAME_ALLOW = "camera; microphone; autoplay; display-capture";

/** The FAKE page is the app's own route: same origin as this page, whatever base the API named. */
export function frameSrc(s: VideoSession): string {
  if (!s.conversation_url) return "";
  if (s.vendor === "FAKE") { try { const u = new URL(s.conversation_url, typeof window === "undefined" ? "http://localhost" : window.location.origin); return `${u.pathname}${u.search}`; } catch { return s.conversation_url; } }
  return s.conversation_url;
}

export function VideoCall({ fixturesMode, firstName, statusTick, onSession }: VideoCallProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState<VideoSession | null>(null);
  // 32.17 rule 15: on the FAKE the picture-in-picture is the borrower's own camera from the permission step (the live call's is the room's local track)
  const selfStream = useRef<MediaStream | null>(null);
  const selfVideo = useRef<HTMLVideoElement>(null);
  const [selfOn, setSelfOn] = useState(false);
  const stopSelf = useCallback(() => { for (const t of selfStream.current?.getTracks() ?? []) t.stop(); selfStream.current = null; setSelfOn(false); }, []);
  useEffect(() => () => stopSelf(), [stopSelf]);
  useEffect(() => { const el = selfVideo.current; if (!el) return; el.srcObject = selfStream.current; if (selfStream.current) void el.play().catch(() => undefined); }, [selfOn, phase]);
  const [permissionNote, setPermissionNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const opening = useRef(false);

  const start = useCallback(async () => {
    if (opening.current) return;
    opening.current = true;
    setError(null); setPermissionNote(null);
    setPhase("opening");
    if (fixturesMode) {
      // FAKE fixtures mode: no API — a recorded call so the screen can be demoed (the layout, the rail, the footer)
      const fake: VideoSession = { video_session_id: "FAKE-video-session", status: "joined", vendor: "FAKE", conversation_url: null, end_reason: null, transcript_ref: null, created_at: new Date().toISOString(), joined_at: new Date().toISOString(), ended_at: null, subject: {}, conversation_id: "conv-1", replica_id: "r_FAKE_stock", borrower_camera: "on" };
      setSession(fake); onSession?.(fake); setPhase("live"); opening.current = false;
      return;
    }
    // the camera for presence, the microphone for the words (32.17 open question 2: VIDEO_BORROWER_CAMERA=off joins audio-only — the API says which);
    // the door is opened at the same time (the account, the first turn, the persona and the room at the vendor take seconds — they run while the browser asks)
    const permissions = (async () => {
      try {
        if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
          for (const t of stream.getAudioTracks()) t.stop();   // the room takes its own tracks; the video track stays for the self-view tile until the room's own is playing, and ends with the call
          stopSelf(); selfStream.current = new MediaStream(stream.getVideoTracks()); setSelfOn(stream.getVideoTracks().length > 0);
        }
      } catch {
        setPermissionNote(copy("video.permission_denied"));
      }
    })();
    const opened = openVideoSession();
    opened.catch(() => undefined);
    try {
      await permissions;
      const s = await opened;
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
    stopSelf();
    if (fixturesMode) { const ended = { ...session, status: "ended" as const, end_reason: "borrower_left", ended_at: new Date().toISOString() }; setSession(ended); onSession?.(ended); setPhase("ended"); return; }
    try { const s = await endVideoSession(session.video_session_id); setSession(s); onSession?.(s); }
    catch { /* the row is the truth: re-read below */ }
    setPhase("ended");
  }, [session, fixturesMode, onSession, stopSelf]);
  // the live room ended (the borrower left through the stage's own control, the vendor shut it down, an error): the session row is the truth
  const onLeft = useCallback((reason: "borrower_left" | "vendor_ended" | "error") => { if (reason === "borrower_left") void leave(); else if (reason === "error") setPhase("failed"); }, [leave]);

  const src = session ? frameSrc(session) : "";
  const join = session && session.vendor !== "FAKE" ? joinOptionsFor(session, firstName) : null;
  const live = phase === "live" && !!session;
  return (
    <section className="sm-video-pane" data-testid="video-call" data-phase={phase} data-vendor={session?.vendor} aria-label="Video call">
      <div className="sm-video-bar">
        <span className="sm-primary-text" data-testid="video-title">{copy("video.title")}</span>
        {session?.vendor === "FAKE" && SHOW_FAKE_MARKERS ? <span className="sm-fake-banner" data-testid="video-fake-marker">{copy("video.fake.marker")}</span> : null}
        <span className="sm-header-spacer" />
        {phase === "live" && !join && !src ? (
          <button type="button" className="sm-btn sm-btn-quiet" data-testid="video-leave" onClick={() => void leave()}>
            {copy("video.leave")}
          </button>
        ) : null}
      </div>
      <div className="sm-video-stage">
        {phase === "opening" ? (
          <>
            <p className="sm-muted" data-testid="video-status">{copy("video.starting")}</p>
            <div className="sm-video-pip" data-testid="video-pip" aria-label="Your camera" hidden={!selfOn}>
              <video ref={selfVideo} autoPlay playsInline muted />
            </div>
          </>
        ) : null}
        {live && join ? (
          <LiveCall join={join} preview={selfOn ? selfStream.current : null} onLeft={onLeft} />
        ) : live ? (
          <div className="sm-video-live" data-testid="video-live" data-state="in" data-replica="fake">
            {fixturesMode || !src ? (
              <div className="sm-video-frame sm-fake-video" data-testid="video-frame-fake">
                <p className="sm-primary-text">{copy("video.fake.marker")}</p>
                <p className="sm-muted">FAKE fixtures mode — no video agent is connected; the rail beside this pane is the recorded record.</p>
              </div>
            ) : (
              <iframe className="sm-video-frame" data-testid="video-frame" title="Video agent" src={src} allow={IFRAME_ALLOW} />
            )}
            <div className="sm-video-pip" data-testid="video-pip" aria-label="Your camera" hidden={!selfOn}>
              <video ref={selfVideo} autoPlay playsInline muted />
            </div>
          </div>
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
