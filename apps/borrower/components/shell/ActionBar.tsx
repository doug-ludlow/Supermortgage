"use client";

import { useId, useRef, useState } from "react";

/**
 * 01 §1.1 Action bar — text input, microphone (in-app voice, §6.3 — placeholder until
 * the telephony adapter lands), attach (document upload → O3.1 intake), and
 * **Talk to a person** (always visible; emits human.transfer.requested via human.request).
 */
export function ActionBar({ onSend, onAttach, onTalkToPerson, onVoice, disabled }: { onSend: (text: string) => void; onAttach: (file: File) => void; onTalkToPerson: () => void; onVoice?: () => void; disabled?: boolean }) {
  const id = useId();
  const [text, setText] = useState("");
  const file = useRef<HTMLInputElement>(null);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  };

  return (
    <form
      className="sm-actionbar"
      data-testid="action-bar"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <button type="button" className="sm-btn sm-iconbtn" aria-label="Attach a document" onClick={() => file.current?.click()} disabled={disabled}>
        <span aria-hidden="true">📎</span>
      </button>
      <input
        ref={file}
        type="file"
        className="sm-visually-hidden"
        accept="image/*,application/pdf"
        tabIndex={-1}
        aria-label="Attach a document"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onAttach(f);
          e.target.value = "";
        }}
      />
      <label htmlFor={id} className="sm-visually-hidden">
        Message
      </label>
      <input
        id={id}
        className="sm-input"
        placeholder="Ask anything, or say what you need"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        disabled={disabled}
        autoComplete="off"
      />
      <button type="button" className="sm-btn sm-iconbtn" aria-label="Talk by voice (coming soon)" onClick={onVoice} disabled={!onVoice || disabled} title="In-app voice — placeholder until the telephony adapter lands">
        <span aria-hidden="true">🎤</span>
      </button>
      <button type="submit" className="sm-btn" disabled={disabled || !text.trim()}>
        Send
      </button>
      <button type="button" className="sm-btn sm-btn-primary sm-talk" data-testid="talk-to-person" onClick={onTalkToPerson}>
        Talk to a person
      </button>
    </form>
  );
}
