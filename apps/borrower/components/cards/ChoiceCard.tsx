"use client";

import { CardFrame, nowIso } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { ChoiceCardEvidence } from "@/lib/types/cards";
import { copy, copyExtra } from "@/lib/copy";

/** 01 §3.2 — 2–4 mutually exclusive options; resolves on tap; never captures a consent. */
export function ChoiceCard({ card, timezone, onResolve, busy, error }: CardComponentProps<"ChoiceCard">) {
  const { options, title, helper, disclosure_version_shown, copy_tokens } = card.props;
  const heading = title || copy(card.copy_key, copy_tokens);   // 32.8: the library's sentence with the server's tokens when the card names only the key (`payment.refund.choice` {{money}})
  const helperText = helper || copyExtra(card.copy_key, "helper", copy_tokens);
  const chosen = (card.evidence as ChoiceCardEvidence | undefined)?.option_id;
  const chosenLabel = options.find((o) => o.id === chosen)?.label;
  const pending = card.status === "pending";

  const pick = (option_id: string) => {
    const evidence: ChoiceCardEvidence = { option_id, tapped_at: nowIso(), disclosure_version_shown };
    void onResolve({ evidence, option_id });
  };

  // One primary action per card: the option flagged is_primary, else the first.
  const primaryId = options.find((o) => o.is_primary)?.id ?? options[0]?.id;

  return (
    <CardFrame card={card} timezone={timezone} title={heading} receipt={chosenLabel ? `${heading} — ${chosenLabel}` : undefined} announce={chosenLabel ? `You chose ${chosenLabel}` : undefined}>
      {helperText ? <p>{helperText}</p> : null}
      <div className="sm-options" role="group" aria-label={heading}>
        {options.slice(0, 4).map((o) => (
          <button key={o.id} type="button" className={`sm-btn sm-option${o.id === primaryId ? " sm-btn-primary" : ""}`} onClick={() => pick(o.id)} disabled={!pending || busy} aria-pressed={chosen === o.id}>
            <span>{o.label}</span>
            {o.sublabel ? <small>{o.sublabel}</small> : null}
          </button>
        ))}
      </div>
      {error ? <p className="sm-error" role="alert">{error}</p> : null}
    </CardFrame>
  );
}
