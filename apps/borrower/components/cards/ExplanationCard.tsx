"use client";

import { useId, useState } from "react";
import { CardFrame, nowIso, textHash } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { ExplanationCardEvidence } from "@/lib/types/cards";
import { copy } from "@/lib/copy";

/**
 * 01 §3.10 — letter of explanation with typed-name attestation; rendered by the API as a signed document.
 * 32.3 SQ-05 (`optional`): the bankruptcy explanation the borrower may add or skip — no typed name (the sequence's last tap is the
 * attestation), the words ride the next card's state and reach `du_declarations.bankruptcy_explanation` verbatim.
 */
export function ExplanationCard({ card, timezone, onResolve, busy, error }: CardComponentProps<"ExplanationCard">) {
  const p = card.props;
  const id = useId();
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const pending = card.status === "pending";
  const optional = p.optional === true;
  const ready = text.trim().length >= p.min_length && (optional || name.trim().length >= 2);
  // 32.5 §3: the subject names the fact, the prompt asks one question — both from the copy library when the card carries keys
  const subject = p.subject || (p.subject_copy_key ? copy(p.subject_copy_key, p.copy_tokens) : copy(card.copy_key, p.copy_tokens));
  const prompt = p.prompt || (p.prompt_copy_key ? copy(p.prompt_copy_key, p.copy_tokens) : "");
  const skipped = (card.evidence as ExplanationCardEvidence | undefined)?.skipped === true;

  const submit = () => {
    const evidence: ExplanationCardEvidence = { text_hash: textHash(text.trim()), attestation: name.trim(), attested_at: nowIso() };
    void onResolve({ evidence: { ...evidence, text: text.trim() }, option_id: "submit" });
  };
  const skip = () => {
    const evidence: ExplanationCardEvidence = { text_hash: textHash(""), attestation: "", attested_at: nowIso(), skipped: true };
    void onResolve({ evidence, option_id: "skip" });
  };

  return (
    <CardFrame card={card} timezone={timezone} title={subject} receipt={skipped ? `${subject} — skipped` : `${subject} — explanation sent`}>
      <p className="sm-primary-text">{prompt}</p>
      {pending ? (
        <>
          <label className="sm-label" htmlFor={`${id}-text`}>
            {optional ? "Your explanation (optional)" : `Your explanation (at least ${p.min_length} characters)`}
          </label>
          <textarea id={`${id}-text`} className="sm-textarea" value={text} onChange={(e) => setText(e.target.value)} />
          {optional ? null : (
            <>
              <label className="sm-label" htmlFor={`${id}-name`} style={{ marginTop: 8 }}>
                Type your full name — this signs the letter
              </label>
              <input id={`${id}-name`} className="sm-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </>
          )}
          <div className="sm-card-actions">
            <button type="button" className="sm-btn sm-btn-primary" onClick={submit} disabled={!ready || busy}>
              Send explanation
            </button>
            {optional ? (
              <button type="button" className="sm-btn" onClick={skip} disabled={busy}>
                Skip
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      {error ? <p className="sm-error" role="alert">{error}</p> : null}
    </CardFrame>
  );
}
