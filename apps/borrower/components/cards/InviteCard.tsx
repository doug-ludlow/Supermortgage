"use client";

import { useId, useState } from "react";
import { CardFrame, nowIso } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { InviteCardEvidence, PartyRole } from "@/lib/types/cards";

const ROLE_LABEL: Record<PartyRole, string> = {
  co_borrower: "Co-borrower",
  non_borrowing_spouse: "Non-borrowing spouse",
  poa: "Power of attorney",
  authorized_third_party: "Authorized third party",
};
const FIELD_LABEL = { first_name: "First name", last_name: "Last name", email: "Email", phone: "Mobile number" } as const;

/** 01 §3.13 — add another party; they get their own conversation and answer their own questions. */
export function InviteCard({ card, timezone, onResolve, busy, error }: CardComponentProps<"InviteCard">) {
  const p = card.props;
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const pending = card.status === "pending";
  const ready = p.contact_fields.every((f) => (values[f] ?? "").trim().length > 0);
  const evid = card.evidence as InviteCardEvidence | undefined;

  const send = () => {
    const evidence: InviteCardEvidence = { party_role: p.party_role, contact: values, invited_at: nowIso() };
    void onResolve({ evidence, option_id: "invite" });
  };

  return (
    <CardFrame card={card} timezone={timezone} title={p.title} receipt={`${ROLE_LABEL[p.party_role]} invited${evid?.contact.first_name ? ` — ${evid.contact.first_name}` : ""}`}>
      <p>
        {ROLE_LABEL[p.party_role]}. They'll get their own link and answer their own questions — you never answer for them.
      </p>
      {pending ? (
        <>
          {p.contact_fields.map((f) => (
            <div key={f} style={{ marginTop: 8 }}>
              <label className="sm-label" htmlFor={`${id}-${f}`}>
                {FIELD_LABEL[f]}
              </label>
              <input id={`${id}-${f}`} className="sm-input" type={f === "email" ? "email" : f === "phone" ? "tel" : "text"} value={values[f] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))} />
            </div>
          ))}
          <div className="sm-card-actions">
            <button type="button" className="sm-btn sm-btn-primary" onClick={send} disabled={!ready || busy}>
              Send invitation
            </button>
          </div>
        </>
      ) : null}
      {error ? <p className="sm-error" role="alert">{error}</p> : null}
    </CardFrame>
  );
}
