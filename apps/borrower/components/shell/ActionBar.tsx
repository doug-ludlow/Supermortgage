"use client";

import { useId, useRef, useState } from "react";

/**
 * 32.16 §1 principle 8 / §2.2 — the input bar: one text input, Send, and attach as an icon (document upload → O3.1
 * intake). No microphone yet (voice is Phase 3, docs/ux/17 §2.4) and no "Talk to a person" control while no person exists —
 * a borrower who wants one types it and the assistant answers in words; the `human.request` path stays in lib/api.
 */
export function ActionBar({ onSend, onAttach, disabled }: { onSend: (text: string) => void; onAttach: (file: File) => void; disabled?: boolean }) {
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
      <button type="button" className="sm-btn sm-iconbtn" aria-label="Attach a document" data-testid="attach" onClick={() => file.current?.click()} disabled={disabled}>
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
      <button type="submit" className="sm-btn sm-btn-primary" data-testid="send" disabled={disabled || !text.trim()}>
        Send
      </button>
    </form>
  );
}
