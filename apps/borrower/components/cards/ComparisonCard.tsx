"use client";

import { CardFrame, nowIso } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { ChoiceCardEvidence } from "@/lib/types/cards";
import { copy, copyExtra } from "@/lib/copy";
import { columnTitle, rowValue } from "@/components/flows/6-decision-property";

/**
 * 01 §3.7 — multi-option numeric choice as columns; values arrive pre-formatted from the
 * projection. Resolves like a ChoiceCard. `stub` renders the Thread's "see options →" on ≥ 1024.
 */
export function ComparisonCard({ card, timezone, onResolve, busy, error, stub, onOpen }: CardComponentProps<"ComparisonCard"> & { stub?: boolean }) {
  const p = card.props;
  const heading = p.title ?? copy(card.copy_key);
  const footnote = p.footnote || copyExtra(card.copy_key, "footnote", p.copy_tokens);   // 32.10: the offer's deadline line from the library when the server named only the key
  const pending = card.status === "pending";
  const chosen = (card.evidence as ChoiceCardEvidence | undefined)?.option_id;
  const chosenCol = p.columns.find((c) => c.id === chosen); const chosenTitle = chosenCol ? columnTitle(chosenCol) : (p.secondary_option && chosen === p.secondary_option.id ? p.secondary_option.label : undefined);

  const pick = (option_id: string) => {
    const evidence: ChoiceCardEvidence = { option_id, tapped_at: nowIso() };
    void onResolve({ evidence, option_id });
  };

  if (stub) {
    return (
      <CardFrame card={card} timezone={timezone} title={heading} receipt={chosenTitle ? `${heading} — ${chosenTitle}` : undefined}>
        <button type="button" className="sm-linkbtn" onClick={() => onOpen?.({ card_instance_id: card.card_instance_id })}>
          see options →
        </button>
      </CardFrame>
    );
  }

  return (
    <CardFrame card={card} timezone={timezone} title={heading} receipt={chosenTitle ? `${heading} — ${chosenTitle}` : undefined} announce={chosenTitle ? `You chose ${chosenTitle}` : undefined}>
      <div className="sm-columns" role="group" aria-label={heading}>
        {p.columns.map((c) => {
          const recommended = c.id === p.recommended_id;
          return (
            <div key={c.id} className="sm-column" data-recommended={recommended}>
              <h4>
                {columnTitle(c)}
                {recommended ? <span className="sm-positive-text"> · recommended</span> : null}
              </h4>
              <dl>
                {c.rows.map((r) => (
                  <div key={r.label}>
                    <dt>{r.label}</dt>
                    <dd data-emphasis={r.emphasis ? "true" : undefined} className="sm-num">
                      {rowValue(r)}
                    </dd>
                  </div>
                ))}
              </dl>
              {c.footnote ? <p className="sm-source">{c.footnote}</p> : null}
              {pending ? (
                <button type="button" className={`sm-btn${recommended || (!p.recommended_id && c === p.columns[0]) ? " sm-btn-primary" : ""}`} style={{ width: "100%", marginTop: 8 }} onClick={() => pick(c.id)} disabled={busy} aria-pressed={chosen === c.id}>
                  Choose {columnTitle(c)}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {pending && p.secondary_option ? (
        <div className="sm-card-actions">
          <button type="button" className="sm-btn" onClick={() => pick(p.secondary_option!.id)} disabled={busy}>
            {p.secondary_option.label}
          </button>
        </div>
      ) : null}
      {footnote ? <p className="sm-card-footer">{footnote}</p> : null}
      {error ? <p className="sm-error" role="alert">{error}</p> : null}
    </CardFrame>
  );
}
