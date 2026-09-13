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

type Track = MediaStreamTrack | null;
type CallLike = {
  join(o: { url: string; userName: string; startVideoOff?: boolean; startAudioOff?: boolean }): Promise<unknown>;
  leave(): Promise<unknown>;
  destroy(): Promise<unknown>;
  on(ev: string, fn: (e?: unknown) => void): unknown;
  participants(): Record<string, { local?: boolean; user_name?: string; tracks?: { video?: { persistentTrack?: MediaStreamTrack; state?: string }; audio?: { persistentTrack?: MediaStreamTrack; state?: string } } }>;
  setLocalAudio(on: boolean): unknown;
  setLocalVideo(on: boolean): unknown;
  localAudio(): boolean;
  localVideo(): boolean;
};

export type LiveCallProps = {
  join: JoinOptions;
  /** The borrower's own camera from the permission step: in the picture-in-picture from the first frame, until the room's own local track plays. */
  preview?: MediaStream | null | undefined;
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

export function LiveCall({ join, preview, onLeft, onJoined }: LiveCallProps) {
  const remoteVideo = useRef<HTMLVideoElement>(null); const remoteAudio = useRef<HTMLAudioElement>(null); const selfVideo = useRef<HTMLVideoElement>(null);
  const call = useRef<CallLike | null>(null);
  const [state, setState] = useState<"joining" | "in" | "left">("joining");
  const [mic, setMic] = useState(true); const [cam, setCam] = useState(!join.startVideoOff);
  const [replicaIn, setReplicaIn] = useState(false);
  const [replicaVideo, setReplicaVideo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const syncTracks = useCallback(() => {
    const c = call.current; if (!c) return;
    const ps = Object.values(c.participants());
    const local = ps.find((p) => p.local); const remote = ps.find((p) => !p.local);
    attach(selfVideo.current, local?.tracks?.video?.state === "playable" ? local.tracks.video.persistentTrack ?? null : preview?.getVideoTracks()[0] ?? null);
    attach(remoteVideo.current, remote?.tracks?.video?.state === "playable" ? remote.tracks.video.persistentTrack ?? null : null);
    attach(remoteAudio.current, remote?.tracks?.audio?.state === "playable" ? remote.tracks.audio.persistentTrack ?? null : null);
    setReplicaIn(!!remote); setReplicaVideo(remote?.tracks?.video?.state === "playable");
  }, [preview]);
  // the self-view before the room's own track: the permission step's camera, from the first frame (32.17 rule 15)
  useEffect(() => { if (!call.current) attach(selfVideo.current, preview?.getVideoTracks()[0] ?? null); }, [preview]);

  useEffect(() => {
    let cancelled = false; let c: CallLike | null = null;
    (async () => {
      const mod = await import("@daily-co/daily-js");
      const Daily = (mod.default ?? mod) as unknown as { createCallObject(o?: object): CallLike };
      if (cancelled) return;
      c = Daily.createCallObject({ subscribeToTracksAutomatically: true }); call.current = c;
      for (const ev of ["joined-meeting", "participant-joined", "participant-updated", "participant-left", "track-started", "track-stopped"]) c.on(ev, () => syncTracks());
      c.on("joined-meeting", () => { setState("in"); onJoined?.(); });
      c.on("left-meeting", () => { setState("left"); onLeft("vendor_ended"); });
      c.on("error", (e) => { setError(String((e as { errorMsg?: string } | undefined)?.errorMsg ?? "call error")); setState("left"); onLeft("error"); });
      try { await c.join({ url: join.url, userName: join.userName, startVideoOff: join.startVideoOff, startAudioOff: join.startAudioOff }); syncTracks(); }
      catch (e) { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setState("left"); onLeft("error"); } }
    })();
    return () => { cancelled = true; const cc = c; call.current = null; if (cc) void cc.leave().catch(() => undefined).then(() => cc.destroy()).catch(() => undefined); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [join.url, join.userName]);

  const toggleMic = () => { const c = call.current; if (!c) return; const next = !mic; c.setLocalAudio(next); setMic(next); };
  const toggleCam = () => { const c = call.current; if (!c) return; const next = !cam; c.setLocalVideo(next); setCam(next); };
  const leave = async () => { const c = call.current; call.current = null; setState("left"); if (c) { await c.leave().catch(() => undefined); await c.destroy().catch(() => undefined); } onLeft("borrower_left"); };

  return (
    <div className="sm-video-live" data-testid="video-live" data-state={state} data-replica={replicaIn ? "in" : "waiting"}>
      <video ref={remoteVideo} className="sm-video-remote" data-testid="video-remote" autoPlay playsInline />
      <audio ref={remoteAudio} autoPlay />
      <div className="sm-video-pip" data-testid="video-pip" aria-label="Your camera">
        <video ref={selfVideo} autoPlay playsInline muted />
      </div>
      {state === "joining" ? <p className="sm-video-overlay sm-muted" data-testid="video-status">{copy("video.joining")}</p> : state === "in" && !replicaVideo ? <p className="sm-video-overlay sm-muted" data-testid="video-status">{copy("video.replica_joining")}</p> : null}
      {error ? <p className="sm-video-overlay sm-error" role="alert">{error}</p> : null}
      <div className="sm-video-controls" data-testid="video-controls">
        <button type="button" className="sm-btn" onClick={toggleMic} aria-pressed={!mic} data-testid="video-mic">{mic ? copy("video.mute") : copy("video.unmute")}</button>
        <button type="button" className="sm-btn" onClick={toggleCam} aria-pressed={!cam} data-testid="video-camera">{cam ? copy("video.camera_off") : copy("video.camera_on")}</button>
        <span className="sm-header-spacer" />
        <button type="button" className="sm-btn sm-btn-quiet" onClick={() => void leave()} data-testid="video-leave">{copy("video.leave")}</button>
      </div>
    </div>
  );
}
