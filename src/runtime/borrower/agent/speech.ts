/**
 * The speech front end (docs/ux/17 §3.6, DELTA-27): speech-to-text and text-to-speech as ports with in-repo FAKEs, so the in-app voice
 * turn and the phone line feed the same agent turn as text does (agent/turn.ts) — the transcript to `messages{voice_turn = true}`, the
 * reply spoken back. Every vendor is a FAKE in every build stage (README "Vendor fakes"); a real adapter implements the same two ports.
 *
 *   SttPort.transcribe   an utterance → {transcript, confidence, utterance_id}. The FAKE echoes the transcript the request carries (a
 *                        test says what the borrower "said") and its confidence (default STT_FAKE_CONFIDENCE); nothing is decoded.
 *   TtsPort.speak        the rendered reply → an audio reference. The FAKE returns a content-addressed reference and never audio.
 *
 * Low confidence (docs/ux/17 §3.4 / 32.16-T20): an utterance below STT_LOW_CONFIDENCE never reaches the model and never becomes a proposal;
 * it counts a miss on the current card (`card_instances.misses`), and the third answers with the card's deep link (the typed path).
 */
import { createHash, randomUUID } from "node:crypto";

export interface SttRequest { readonly transcript?: string | null; readonly audio_base64?: string | null; readonly confidence?: number | null; readonly utterance_id?: string | null; readonly language?: string | null }
export interface SttResult { readonly transcript: string; readonly confidence: number; readonly utterance_id: string; readonly vendor: string; readonly language: string }
export interface SttPort { readonly vendorName: string; transcribe(i: SttRequest): Promise<SttResult> }
export interface TtsResult { readonly audio_ref: string; readonly vendor: string; readonly chars: number }
export interface TtsPort { readonly vendorName: string; speak(text: string, opts?: { readonly language?: string }): Promise<TtsResult> }

/** Below this the transcript is not trusted (§3.4 "STT returns low confidence"): no turn, no proposal, a miss on the current card. */
export const STT_LOW_CONFIDENCE = 0.6;
/** The FAKE's confidence when the request states none. */
export const STT_FAKE_CONFIDENCE = 0.96;
/** 32.16-T20 / §3.7: the third low-confidence miss on a card answers with its deep link — the card is typed, never heard again. */
export const LOW_CONFIDENCE_MISSES_TO_LINK = 3;

const clamp = (n: unknown, fallback: number): number => { const v = typeof n === "number" ? n : typeof n === "string" && n.trim() !== "" ? Number(n) : NaN; return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback; };

/** FAKE speech-to-text: the transcript and the confidence are the request's own (a test's utterance); an audio payload without a transcript decodes to nothing. */
export class FakeStt implements SttPort {
  readonly vendorName = "FAKE" as const;
  readonly log: { vendor: "FAKE"; utterance_id: string; confidence: number; chars: number }[] = [];
  async transcribe(i: SttRequest): Promise<SttResult> {
    const transcript = typeof i.transcript === "string" ? i.transcript.trim().slice(0, 4000) : "";
    const confidence = transcript ? clamp(i.confidence, STT_FAKE_CONFIDENCE) : 0;
    const utterance_id = typeof i.utterance_id === "string" && i.utterance_id.trim() ? i.utterance_id.trim().slice(0, 80) : `utt_${randomUUID()}`;
    this.log.push({ vendor: "FAKE", utterance_id, confidence, chars: transcript.length });
    return { transcript, confidence, utterance_id, vendor: "FAKE", language: typeof i.language === "string" && i.language ? i.language : "en-US" };
  }
}
/** FAKE text-to-speech: a content-addressed reference (never audio), so a spoken reply is traceable to the text that was rendered for it. */
export class FakeTts implements TtsPort {
  readonly vendorName = "FAKE" as const;
  readonly log: { vendor: "FAKE"; audio_ref: string; chars: number }[] = [];
  async speak(text: string): Promise<TtsResult> {
    const audio_ref = `fake-tts:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
    const r = { audio_ref, vendor: "FAKE" as const, chars: text.length }; this.log.push(r); return r;
  }
}

/** The hash a voice attestation carries (`card_instance_events.evidence.hash`): the utterance, its transcript reference and the copy read back, so the row proves which read-back the "yes" answered. */
export const attestationHash = (i: { utterance_id: string; transcript_ref: string; read_back_copy_key: string; spoken_text: string }): string =>
  createHash("sha256").update(`${i.utterance_id}\n${i.transcript_ref}\n${i.read_back_copy_key}\n${i.spoken_text}`).digest("hex");
