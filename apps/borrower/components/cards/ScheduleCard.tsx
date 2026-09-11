"use client";

import { useState } from "react";
import { CardFrame, nowIso } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { ScheduleCardEvidence, SchedulePurpose } from "@/lib/types/cards";
import { copy } from "@/lib/copy";
import { formatDate } from "@/lib/format";
import { SHOW_FAKE_MARKERS } from "@/lib/env";

const PURPOSE_LABEL: Record<SchedulePurpose, string> = {
  appraisal_access: "Appraiser visit",
  pdc_access: "Property data collection visit",
  ron_session: "Signing session",
  callback: "Call back",
};

/** 01 §3.11 — pick a time window; slots come from the AMC / RON platform / telephony. */
export function ScheduleCard({ card, timezone, onResolve, busy, error }: CardComponentProps<"ScheduleCard">) {
  const p = card.props;
  const [slot, setSlot] = useState<string | undefined>();
  const pending = card.status === "pending";
  const chosen = (card.evidence as ScheduleCardEvidence | undefined)?.slot_id ?? slot;
  const chosenSlot = p.slots.find((s) => s.id === chosen);
  const heading = p.title ?? copy(card.copy_key);
  // FAKE: RON platform / AMC slot providers are test doubles outside production.
  const fakeVendor = SHOW_FAKE_MARKERS && p.purpose === "ron_session" ? "RON platform" : SHOW_FAKE_MARKERS && p.purpose !== "callback" ? "AMC scheduling" : undefined;

  const confirm = () => {
    if (!slot) return;
    const evidence: ScheduleCardEvidence = { slot_id: slot, chosen_at: nowIso() };
    void onResolve({ evidence, option_id: slot });
  };

  return (
    <CardFrame card={card} timezone={timezone} title={heading} receipt={chosenSlot ? `${PURPOSE_LABEL[p.purpose]} — ${formatDate(chosenSlot.starts_at, timezone, "datetime")}` : undefined} fakeVendor={fakeVendor}>
      {p.helper ? <p>{p.helper}</p> : null}
      {p.constraints_text ? <p>{p.constraints_text}</p> : null}
      <fieldset className="sm-fieldset">
        <legend>{PURPOSE_LABEL[p.purpose]} — pick a time</legend>
        <div className="sm-radios">
          {p.slots.map((s) => (
            <label key={s.id}>
              <input type="radio" name={`slot-${card.card_instance_id}`} value={s.id} checked={chosen === s.id} onChange={() => setSlot(s.id)} disabled={!pending} />
              <time dateTime={s.starts_at}>{s.label ?? `${formatDate(s.starts_at, timezone, "datetime")} – ${formatDate(s.ends_at, timezone, "time")}`}</time>
            </label>
          ))}
        </div>
      </fieldset>
      {pending ? (
        <div className="sm-card-actions">
          <button type="button" className="sm-btn sm-btn-primary" onClick={confirm} disabled={!slot || busy}>
            Book this time
          </button>
        </div>
      ) : null}
      {error ? <p className="sm-error" role="alert">{error}</p> : null}
    </CardFrame>
  );
}
