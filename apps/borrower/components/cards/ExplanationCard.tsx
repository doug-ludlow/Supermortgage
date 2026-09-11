"use client";

import { useId, useState } from "react";
import { CardFrame, nowIso, textHash } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { ExplanationCardEvidence } from "@/lib/types/cards";
import { copy } from "@/lib/copy";

/** 01 §3.10 — letter of explanation with typed-name attestation; rendered by the API as a signed document. */
export function ExplanationCard({ card, timezone, onResolve, busy, error }: CardComponentProps<"ExplanationCard">) {
  const p = card.props;
  const id = useId();
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const pending = card.status === "pending";
  const ready = text.trim().length >= p.min_length && name.trim().length >= 2;
  // 32.5 §3: the subject names the fact, the prompt asks one question — both from the copy library when the card carries keys
  const subject = p.subject || (p.subject_copy_key ? copy(p.subject_copy_key, p.copy_tokens) : copy(card.copy_key, p.copy_tokens));
  const prompt = p.prompt || (p.prompt_copy_key ? copy(p.prompt_copy_key, p.copy_tokens) : "");

  const submit = () => {
    const evidence: ExplanationCardEvidence = { text_hash: textHash(text.trim()), attestation: name.trim(), attested_at: nowIso() };
    void onResolve({ evidence: { ...evidence, text: text.trim() }, option_id: "submit" });
  };

  return (
    <CardFrame card={card} timezone={timezone} title={subject} receipt={`${subject} — explanation sent`}>
      <p className="sm-primary-text">{prompt}</p>
      {pending ? (
        <>
          <label className="sm-label" htmlFor={`${id}-text`}>
            Your explanation (at least {p.min_length} characters)
          </label>
          <textarea id={`${id}-text`} className="sm-textarea" value={text} onChange={(e) => setText(e.target.value)} />
          <label className="sm-label" htmlFor={`${id}-name`} style={{ marginTop: 8 }}>
            Type your full name — this signs the letter
          </label>
          <input id={`${id}-name`} className="sm-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          <div className="sm-card-actions">
            <button type="button" className="sm-btn sm-btn-primary" onClick={submit} disabled={!ready || busy}>
              Send explanation
            </button>
          </div>
        </>
      ) : null}
      {error ? <p className="sm-error" role="alert">{error}</p> : null}
    </CardFrame>
  );
}
