"use client";

/**
 * 32.17 rule 15 — the live call, in Supermortgage's own frame: the vendor's room is joined through its JavaScript client in
 * call-object mode (no prebuilt page, so no vendor pre-join screen and no vendor chrome), the replica's video fills the stage,
 * the borrower's own camera is a picture-in-picture tile, and the controls (mute, camera, leave) are the page's. Nothing of the
 * borrower's media is kept: the tracks are the room's and end with it. The brain is still the endpoint (rule 1): this component
 * never sends the vendor an utterance or an answer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { JoinOptions } from "@/lib/video/join";
import { copy } from "@/lib/copy";
import { SHOW_FAKE_MARKERS } from "@/lib/env";

/** Seconds in the room without the replica's video before the stage says she is late (the call stays; Leave is one tap). */
export const REPLICA_LATE_S = 40;

type Track = MediaStreamTrack | null;
type CallLike = {
  join(o: { url: string; userName: string; startVideoOff?: boolean; startAudioOff?: boolean }): Promise<unknown>;
  leave(): Promise<unknown>;
  destroy(): Promise<unknown>;
  on(ev: string, fn: (e?: unknown) => void): unknown;
  participants(): Record<string, { local?: boolean; user_name?: string; tracks?: { video?: { persistentTrack?: MediaStreamTrack; state?: string }; audio?: { persistentTrack?: MediaStreamTrack; state?: string } } }>;
  sendAppMessage(data: unknown, to?: string): unknown;
  setLocalAudio(on: boolean): unknown;
  setLocalVideo(on: boolean): unknown;
  localAudio(): boolean;
  localVideo(): boolean;
};

export type LiveCallProps = {
  join: JoinOptions;
  /** The borrower's own camera from the permission step: in the picture-in-picture from the first frame, until the room's own local track plays. */
  preview?: MediaStream | null | undefined;
  /** 32.17 rule 17: the opening turn's rendered text (GET …/greeting) — spoken by the replica once, as one conversation.echo, after its own greeting; null until it has landed. */
  echo?: string | null | undefined;
  /** The vendor's conversation id the echo names. */
  vendorConversationId?: string | null | undefined;
  onEchoed?: () => void;
  onLeft: (reason: "borrower_left" | "vendor_ended" | "error") => void;
  onJoined?: () => void;
};

function attach(el: HTMLVideoElement | HTMLAudioElement | null, track: Track): void {
  if (!el) return;
  const current = el.srcObject as MediaStream | null;
  if (!track) { if (current) el.srcObject = null; return; }
  if (current && current.getTracks()[0] === track) return;
  el.srcObject = new MediaStream([track]);
  void el.play().catch(() => undefined);
}

/** Seconds after the replica's video started before the echo is sent when the vendor's "stopped speaking" event never comes. */
export const ECHO_FALLBACK_S = 9;
/** The vendor's interaction message: the replica finished speaking (Tavus `conversation.replica.stopped_speaking`; the older `conversation.stopped_speaking` counted the same way). */
export const isReplicaStoppedSpeaking = (data: unknown): boolean => {
  const t = data && typeof data === "object" ? String((data as { event_type?: unknown }).event_type ?? "") : "";
  return /stopped_speaking$/.test(t) && !/user/.test(t);
};
/** The one message the page sends the vendor (rule 17): the opening turn's guarded text, as the interactions protocol's echo. */
export const echoMessage = (conversationId: string, text: string): Record<string, unknown> => ({ message_type: "conversation", event_type: "conversation.echo", conversation_id: conversationId, properties: { text } });

/** One call object at a time on the page (the vendor's client refuses a second): the next one is created only after the last has been destroyed. */
let lastCallGone: Promise<unknown> = Promise.resolve();

export function LiveCall({ join, preview, echo, vendorConversationId, onEchoed, onLeft, onJoined }: LiveCallProps) {
  const remoteVideo = useRef<HTMLVideoElement>(null); const remoteAudio = useRef<HTMLAudioElement>(null); const selfVideo = useRef<HTMLVideoElement>(null);
  const call = useRef<CallLike | null>(null);
  const [state, setState] = useState<"joining" | "in" | "left">("joining");
  const [mic, setMic] = useState(true); const [cam, setCam] = useState(!join.startVideoOff);
  const [replicaIn, setReplicaIn] = useState(false);
  const [replicaVideo, setReplicaVideo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState(0);
  // the room's events with the second they came, for the dev-mode line (what the deploy walk records when the replica never shows)
  const startedAt = useRef(Date.now());
  const [events, setEvents] = useState<string[]>([]);
  const note = useCallback((what: string) => setEvents((cur) => [...cur.slice(-11), `${what}@${Math.round((Date.now() - startedAt.current) / 100) / 10}s`]), []);
  // rule 17: the echo goes once — after the replica's own greeting (its "stopped speaking" event), or ECHO_FALLBACK_S after its video started
  const [replicaVideoAt, setReplicaVideoAt] = useState<number | null>(null);
  const [replicaStopped, setReplicaStopped] = useState(0);
  const [fallbackDue, setFallbackDue] = useState(false);
  const echoed = useRef(false);
  useEffect(() => { if (replicaVideo && replicaVideoAt === null) setReplicaVideoAt(Date.now()); }, [replicaVideo, replicaVideoAt]);
  useEffect(() => { if (replicaVideoAt === null) return; const t = setTimeout(() => setFallbackDue(true), ECHO_FALLBACK_S * 1000); return () => clearTimeout(t); }, [replicaVideoAt]);
  useEffect(() => {
    const c = call.current; if (!c || echoed.current || !echo || !vendorConversationId || state !== "in" || replicaVideoAt === null) return;
    if (!(replicaStopped > 0 || fallbackDue)) return;
    echoed.current = true;
    try { c.sendAppMessage(echoMessage(vendorConversationId, echo), "*"); onEchoed?.(); } catch (e) { console.warn("video: echo failed", e); }
  }, [echo, vendorConversationId, state, replicaVideoAt, replicaStopped, fallbackDue, onEchoed]);
  const [joinedAt, setJoinedAt] = useState<number | null>(null);
  const [waitS, setWaitS] = useState(0);
  // the seconds since the room was joined while the replica's video is not yet playing (the late line, the dev-mode line)
  useEffect(() => {
    if (joinedAt === null || replicaVideo) return;
    const t = setInterval(() => setWaitS(Math.floor((Date.now() - joinedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [joinedAt, replicaVideo]);

  const syncTracks = useCallback(() => {
    const c = call.current; if (!c) return;
    const ps = Object.values(c.participants());
    const local = ps.find((p) => p.local); const remote = ps.find((p) => !p.local);
    attach(selfVideo.current, local?.tracks?.video?.state === "playable" ? local.tracks.video.persistentTrack ?? null : preview?.getVideoTracks()[0] ?? null);
    attach(remoteVideo.current, remote?.tracks?.video?.state === "playable" ? remote.tracks.video.persistentTrack ?? null : null);
    attach(remoteAudio.current, remote?.tracks?.audio?.state === "playable" ? remote.tracks.audio.persistentTrack ?? null : null);
    setReplicaIn(!!remote); setReplicaVideo(remote?.tracks?.video?.state === "playable"); setParticipants(ps.length);
  }, [preview]);
  // the self-view before the room's own track: the permission step's camera, from the first frame (32.17 rule 15)
  useEffect(() => { if (!call.current) attach(selfVideo.current, preview?.getVideoTracks()[0] ?? null); }, [preview]);

  useEffect(() => {
    let cancelled = false; let c: CallLike | null = null;
    (async () => {
      const mod = await import("@daily-co/daily-js");
      const Daily = (mod.default ?? mod) as unknown as { createCallObject(o?: object): CallLike };
      await lastCallGone;   // the previous call object (a call this page left) is gone before the next is made
      if (cancelled) return;
      try { c = Daily.createCallObject({ subscribeToTracksAutomatically: true }); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); note("create-failed"); setState("left"); onLeft("error"); return; }
      call.current = c;
      for (const ev of ["joined-meeting", "participant-joined", "participant-updated", "participant-left", "track-started", "track-stopped"]) c.on(ev, () => syncTracks());
      for (const ev of ["joining-meeting", "joined-meeting", "participant-joined", "participant-left", "left-meeting", "error", "nonfatal-error", "camera-error"]) c.on(ev, () => note(ev));
      c.on("track-started", (e) => { const p = (e as { participant?: { local?: boolean }; track?: { kind?: string } } | undefined); note(`track-${p?.track?.kind ?? "?"}-${p?.participant?.local ? "local" : "remote"}`); });
      c.on("joined-meeting", () => { setState("in"); setJoinedAt(Date.now()); onJoined?.(); });
      c.on("nonfatal-error", (e) => { console.warn("video: non-fatal room error", e); });
      c.on("app-message", (e) => { const data = (e as { data?: unknown } | undefined)?.data; if (isReplicaStoppedSpeaking(data)) setReplicaStopped((n) => n + 1); });
      c.on("left-meeting", () => { if (!cancelled) { setState("left"); onLeft("vendor_ended"); } });
      c.on("error", (e) => { setError(String((e as { errorMsg?: string } | undefined)?.errorMsg ?? "call error")); setState("left"); onLeft("error"); });
      try { await c.join({ url: join.url, userName: join.userName, startVideoOff: join.startVideoOff, startAudioOff: join.startAudioOff }); syncTracks(); }
      catch (e) { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); note("join-failed"); setState("left"); onLeft("error"); } }
    })();
    return () => { cancelled = true; const cc = c; call.current = null; if (cc) lastCallGone = cc.leave().catch(() => undefined).then(() => cc.destroy()).catch(() => undefined); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [join.url, join.userName]);

  const toggleMic = () => { const c = call.current; if (!c) return; const next = !mic; c.setLocalAudio(next); setMic(next); };
  const toggleCam = () => { const c = call.current; if (!c) return; const next = !cam; c.setLocalVideo(next); setCam(next); };
  const leave = async () => { const c = call.current; call.current = null; setState("left"); if (c) { lastCallGone = c.leave().catch(() => undefined).then(() => c.destroy()).catch(() => undefined); await lastCallGone; } onLeft("borrower_left"); };

  return (
    <div className="sm-video-live" data-testid="video-live" data-state={state} data-replica={replicaVideo ? "in" : replicaIn ? "joined" : "waiting"} data-echoed={echoed.current ? "1" : undefined}>
      <video ref={remoteVideo} className="sm-video-remote" data-testid="video-remote" autoPlay playsInline />
      <audio ref={remoteAudio} autoPlay />
      <div className="sm-video-pip" data-testid="video-pip" aria-label="Your camera">
        <video ref={selfVideo} autoPlay playsInline muted />
      </div>
      {state === "joining" ? <p className="sm-video-overlay sm-muted" data-testid="video-status">{copy("video.joining")}</p> : state === "in" && !replicaVideo ? <p className="sm-video-overlay sm-muted" data-testid="video-status" data-late={waitS >= REPLICA_LATE_S ? "1" : undefined}>{waitS >= REPLICA_LATE_S ? copy("video.replica_late") : copy("video.replica_joining")}</p> : null}
      {error ? <p className="sm-video-overlay sm-error" role="alert" data-testid="video-error">{error}</p> : null}
      {SHOW_FAKE_MARKERS ? <p className="sm-video-debug" data-testid="video-debug">{`room: ${state} · in the room: ${participants} · Michelle: ${replicaVideo ? "video playing" : replicaIn ? "joined, no video yet" : "not in the room"}${!replicaVideo && joinedAt !== null ? ` · ${waitS}s` : ""} · ${events.join(" ")}`}</p> : null}
      <div className="sm-video-controls" data-testid="video-controls">
        <button type="button" className="sm-btn" onClick={toggleMic} aria-pressed={!mic} data-testid="video-mic">{mic ? copy("video.mute") : copy("video.unmute")}</button>
        <button type="button" className="sm-btn" onClick={toggleCam} aria-pressed={!cam} data-testid="video-camera">{cam ? copy("video.camera_off") : copy("video.camera_on")}</button>
        <span className="sm-header-spacer" />
        <button type="button" className="sm-btn sm-btn-quiet" onClick={() => void leave()} data-testid="video-leave">{copy("video.leave")}</button>
      </div>
    </div>
  );
}
