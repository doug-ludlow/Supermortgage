"use client";

import { useId, useState } from "react";
import { CardFrame, nowIso } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { ProfileCardEvidence } from "@/lib/types/cards";

/** 01 §3.18 — URLA 1a facts only the borrower can supply. No visual default counts as an answer; each field needs a tap. */
export function ProfileCard({ card, timezone, onResolve, busy, error }: CardComponentProps<"ProfileCard">) {
  const p = card.props;
  const id = useId();
  const [answers, setAnswers] = useState<Record<string, { value: string; answered_at: string }>>({});
  const pending = card.status === "pending";
  const complete = p.fields.every((f) => answers[f.path] !== undefined);

  const set = (path: string, value: string) => setAnswers((a) => ({ ...a, [path]: { value, answered_at: nowIso() } }));

  const submit = () => {
    const evidence: ProfileCardEvidence = { fields: p.fields.map((f) => ({ path: f.path, value: answers[f.path]?.value ?? "", answered_at: answers[f.path]?.answered_at ?? nowIso() })) };
    void onResolve({ evidence, option_id: "submit" });
  };

  return (
    <CardFrame card={card} timezone={timezone} title={p.title} receipt={`${p.title} — answered`}>
      {p.fields.map((f) => (
        <fieldset key={f.path} className="sm-fieldset">
          <legend>{f.label}</legend>
          {f.statement ? <p className="sm-source">{f.statement}</p> : null}
          {f.options ? (
            <div className="sm-radios">
              {f.options.map((o) => (
                <label key={o.id}>
                  <input type="radio" name={`${id}-${f.path}`} value={o.id} checked={answers[f.path]?.value === o.id} onChange={() => set(f.path, o.id)} disabled={!pending} />
                  {o.label}
                </label>
              ))}
            </div>
          ) : (
            <input className="sm-input" type={f.input === "number" ? "number" : "text"} inputMode={f.input === "number" ? "numeric" : undefined} aria-label={f.label} value={answers[f.path]?.value ?? ""} onChange={(e) => set(f.path, e.target.value)} disabled={!pending} />
          )}
        </fieldset>
      ))}
      {pending ? (
        <div className="sm-card-actions">
          <button type="button" className="sm-btn sm-btn-primary" onClick={submit} disabled={!complete || busy}>
            Save answers
          </button>
        </div>
      ) : null}
      {error ? <p className="sm-error" role="alert">{error}</p> : null}
    </CardFrame>
  );
}
