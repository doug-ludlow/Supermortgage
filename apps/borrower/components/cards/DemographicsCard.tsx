"use client";

import { useId, useState } from "react";
import { CardFrame, nowIso } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { DemographicOption, DemographicsCardEvidence } from "@/lib/types/cards";

const DECLINE_ID = "do_not_wish";

/**
 * 01 §3.19 — Reg C App. B / Reg B §1002.13 request. Values commit to `applicant_demographics`
 * (write-once; never read back into the UI); the evidence carries only
 * {collection_method, answered_at}. Answers travel in the resolve body under `answers`,
 * separate from `evidence`, so they are never copied to ui_events.
 */
export function DemographicsCard({ card, timezone, onResolve, busy, error }: CardComponentProps<"DemographicsCard">) {
  const p = card.props;
  const id = useId();
  const pending = card.status === "pending";
  const [eth, setEth] = useState<Set<string>>(new Set());
  const [race, setRace] = useState<Set<string>>(new Set());
  const [sex, setSex] = useState<string | undefined>();
  const complete = eth.size > 0 && race.size > 0 && sex !== undefined;

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, optId: string) => {
    const next = new Set(set);
    if (optId === DECLINE_ID) {
      setter(next.has(DECLINE_ID) ? new Set() : new Set([DECLINE_ID]));
      return;
    }
    next.delete(DECLINE_ID);
    if (next.has(optId)) next.delete(optId);
    else next.add(optId);
    setter(next);
  };

  const submit = () => {
    const evidence: DemographicsCardEvidence = { collection_method: p.collection_method, answered_at: nowIso() };
    void onResolve({ evidence: { ...evidence, answers: { ethnicity: [...eth], race: [...race], sex } }, option_id: "submit" });
  };

  const group = (label: string, opts: DemographicOption[], selected: Set<string>, setter: (s: Set<string>) => void) => (
    <fieldset className="sm-fieldset">
      <legend>{label}</legend>
      <div className="sm-radios">
        {opts.map((o) => (
          <div key={o.id}>
            <label>
              <input type="checkbox" checked={selected.has(o.id)} onChange={() => toggle(selected, setter, o.id)} disabled={!pending} />
              {o.label}
            </label>
            {o.sub && selected.has(o.id) ? (
              <div className="sm-radios sm-sub">
                {o.sub.map((s) => (
                  <label key={s.id}>
                    <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(selected, setter, s.id)} disabled={!pending} />
                    {s.label}
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        <label>
          <input type="checkbox" checked={selected.has(DECLINE_ID)} onChange={() => toggle(selected, setter, DECLINE_ID)} disabled={!pending} />I do not wish to provide
        </label>
      </div>
    </fieldset>
  );

  if (!p.available) {
    return (
      <CardFrame card={card} timezone={timezone} title="Demographic information" collapsible={false}>
        <p>This is asked once your application has started.</p>
      </CardFrame>
    );
  }

  return (
    <CardFrame card={card} timezone={timezone} title="Demographic information" receipt="Demographic information — answered">
      <div className="sm-card-block">
        <p className="sm-primary-text" style={{ whiteSpace: "pre-wrap" }}>
          {p.statement_text}
        </p>
      </div>
      {group("Ethnicity", p.ethnicity_options ?? p.ethnicity ?? [], eth, setEth)}
      {group("Race", p.race_options ?? p.race ?? [], race, setRace)}
      <fieldset className="sm-fieldset">
        <legend>Sex</legend>
        <div className="sm-radios">
          {[...(p.sex_options ?? p.sex ?? []), { id: DECLINE_ID, label: "I do not wish to provide" }].map((o) => (
            <label key={o.id}>
              <input type="radio" name={`${id}-sex`} value={o.id} checked={sex === o.id} onChange={() => setSex(o.id)} disabled={!pending} />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>
      {pending ? (
        <div className="sm-card-actions">
          <button type="button" className="sm-btn sm-btn-primary" onClick={submit} disabled={!complete || busy}>
            Save
          </button>
        </div>
      ) : null}
      {error ? <p className="sm-error" role="alert">{error}</p> : null}
    </CardFrame>
  );
}
