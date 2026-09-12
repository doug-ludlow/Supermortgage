"use client";

/**
 * Talk — the whole entry as one conversation: the agent asks, you type or speak, it does the rest through the same tools
 * the chips use. Nothing on the page but the transcript, one input, a microphone and a speaker toggle.
 *
 * Voice is the browser's own: SpeechRecognition for the microphone, speechSynthesis for reading the agent's lines aloud. No
 * vendor, no account, nothing leaves the browser except the text.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { talk, type TalkLine, type TalkTurn } from "@/lib/api/talk";
import { ApiRequestError } from "@/lib/api/client";
import { copy, copyOptions } from "@/lib/copy";
import { FooterDisclosure } from "@/components/shell/FooterDisclosure";

type Recognition = { start(): void; stop(): void; lang: string; interimResults: boolean; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };
type RecognitionCtor = new () => Recognition;
const recognitionCtor = (): RecognitionCtor | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export function Talk() {
  const [turns, setTurns] = useState<TalkLine[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState<{ name: string; model: string | null } | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [handoff, setHandoff] = useState(false);   // account.from_talk arrived: the Create account link (docs/ux/17 §2.0 — the account is the door)
  const [speak, setSpeak] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef<Recognition | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const canListen = recognitionCtor() !== null;

  const say = useCallback((lines: TalkLine[]) => {
    if (!speak || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    for (const l of lines) if (l.role !== "you") window.speechSynthesis.speak(new SpeechSynthesisUtterance(l.text));
  }, [speak]);

  const apply = useCallback((r: TalkTurn) => {
    setTurns(r.transcript);
    setAgent({ name: r.agent, model: r.model });
    if (r.session_opened || r.step === "signed_in") setSignedIn(true);
    if (r.transcript.some((l) => l.copy_key === "account.from_talk")) setHandoff(true);
    say(r.lines);
  }, [say]);

  const send = useCallback(async (t?: string) => {
    const msg = (t ?? text).trim();
    if (busy) return;
    setBusy(true); setError(null);
    if (msg) { setTurns((cur) => [...cur, { role: "you", text: msg, at: new Date().toISOString() }]); setText(""); }
    try { apply(await talk(msg || undefined)); }
    catch (e) {
      const code = e instanceof ApiRequestError ? e.body.code : "";
      setError(code === "TALK_NOT_CONFIGURED" ? "The conversational entry is not configured on this server yet." : code === "NOT_WIRED" ? "No partner is configured on this server yet." : copy("error.generic"));
    }
    finally { setBusy(false); inputRef.current?.focus(); }
  }, [apply, busy, text]);

  useEffect(() => { void send(""); /* the first turn: the disclosure and the first question */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [turns, busy]);

  const listen = () => {
    const Ctor = recognitionCtor(); if (!Ctor) return;
    if (listening) { recRef.current?.stop(); return; }
    const rec = new Ctor(); rec.lang = "en-US"; rec.interimResults = false;
    rec.onresult = (e) => { const heard = Array.from(e.results).map((r) => r[0]?.transcript ?? "").join(" ").trim(); if (heard) void send(heard); };
    rec.onend = () => setListening(false); rec.onerror = () => setListening(false);
    recRef.current = rec; setListening(true); rec.start();
  };

  return (
    <main className="sm-talk" aria-label="Conversation" data-testid="talk">
      <div role="log" aria-live="polite" data-step={signedIn ? "signed_in" : handoff ? "sign_up" : undefined}>
        <ol className="sm-talk-log">
          {turns.map((l, i) => (
            <li key={i} className={`sm-talk-line sm-talk-${l.role}`} data-role={l.role} data-copy-key={l.copy_key}>
              {l.role === "you" ? <span className="sm-source sm-talk-you">You</span> : null}
              <span className="sm-talk-text">{l.text}</span>
            </li>
          ))}
          {busy ? <li className="sm-talk-line sm-talk-agent sm-talk-thinking" aria-label="working">…</li> : null}
        </ol>
        <div ref={endRef} />
      </div>
      {error ? <p role="alert" className="sm-talk-error">{error}</p> : null}
      {signedIn ? (
        <p className="sm-talk-file">
          <a href="/app">Open your file</a>
        </p>
      ) : handoff ? (
        <p className="sm-talk-file">
          <a href="/app/sign-up" className="sm-btn sm-btn-primary" data-testid="talk-sign-up">{copyOptions("account.from_talk")[0] ?? "Create your account"}</a>
        </p>
      ) : null}
      <form className="sm-talk-bar" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input ref={inputRef} className="sm-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={listening ? "Listening…" : "Type here"} aria-label="Your message" autoComplete="off" autoFocus disabled={busy} data-testid="talk-input" />
        {canListen ? (
          <button type="button" className={`sm-btn sm-iconbtn${listening ? " sm-btn-primary" : ""}`} onClick={listen} aria-pressed={listening} aria-label={listening ? "Stop listening" : "Speak"} title="Speak" disabled={busy}>
            <span aria-hidden="true">🎤</span>
          </button>
        ) : null}
        <button type="button" className={`sm-btn sm-iconbtn${speak ? " sm-btn-primary" : ""}`} onClick={() => setSpeak((v) => !v)} aria-pressed={speak} aria-label={speak ? "Stop reading aloud" : "Read aloud"} title="Read aloud">
          <span aria-hidden="true">🔊</span>
        </button>
        <button type="submit" className="sm-btn sm-btn-primary" disabled={busy || !text.trim()} data-testid="talk-send">Send</button>
      </form>
      {agent ? (
        <p className="sm-source sm-talk-foot">
          {`${agent.name}${agent.model ? ` · ${agent.model}` : ""}`}
        </p>
      ) : null}
      <FooterDisclosure />
      <style>{`
        .sm-talk { max-width: 720px; margin: 0 auto; padding: 16px 16px 0; display: flex; flex-direction: column; height: 100dvh; box-sizing: border-box; }
        .sm-talk > [role="log"] { flex: 1; min-height: 0; overflow-y: auto; }
        .sm-talk-log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
        .sm-talk-line { line-height: 1.5; max-width: 60ch; }
        .sm-talk-you { display: block; }
        .sm-talk-you + .sm-talk-text { font-weight: 600; }
        .sm-talk-line.sm-talk-you { align-self: flex-end; text-align: right; }
        .sm-talk-notice { opacity: 0.8; font-size: 0.95em; }
        .sm-talk-thinking { opacity: 0.5; }
        .sm-talk-bar { display: flex; gap: 8px; padding-top: 12px; background: var(--sm-bg, transparent); }
        .sm-talk .sm-footer { margin: 8px -16px 0; }
        .sm-talk-bar .sm-input { flex: 1; min-width: 0; }
        .sm-talk-error { color: var(--sm-danger, #e5484d); }
        .sm-talk-foot { margin: 8px 0 0; }
        .sm-talk-file a { font-weight: 700; } /* 19px bold: large text for the AA contrast bar on the accent */
      `}</style>
    </main>
  );
}
