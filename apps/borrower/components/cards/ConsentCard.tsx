"use client";

import { useId, useState } from "react";
import { CardFrame, nowIso, textHash } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { ConsentCardEvidence } from "@/lib/types/cards";
import { copy, copyExtra } from "@/lib/copy";
import { ConsentElements } from "@/components/flows/7-closing";

/**
 * 01 §3.5 — capture a legally sufficient consent. `checkbox_with_text` + typed name for
 * esign / credit_authorization / tcpa_* / autodraft_authorization / joint_intent / standing;
 * single tap for ai_disclosure_ack. Voice never resolves this card (the API enforces it; the
 * UI only ever submits from a tap).
 */
export function ConsentCard({ card, timezone, onResolve, busy, error }: CardComponentProps<"ConsentCard">) {
  const p = card.props;
  const id = useId();
  const [checked, setChecked] = useState(false);
  const [name, setName] = useState("");
  const pending = card.status === "pending";
  const heading = p.title || copy(card.copy_key, p.copy_tokens);   // 32.5 §7: `consent.joint_intent.title` names the other borrower ({{other_first_name}})
  // 32.7 §6: the library's body/helper/footer when the server left them empty and named only the key (the autodraft authorization, the servicing E-SIGN offer)
  const bodyText = p.body_text || copyExtra(card.copy_key, "body", p.copy_tokens) || "";
  const helperText = p.helper_text || copyExtra(card.copy_key, "helper", p.copy_tokens);
  const footerText = p.footer_text || copyExtra(card.copy_key, "footer", p.copy_tokens);
  const singleTap = p.affirmation_method === "single_tap";
  const ready = singleTap || (checked && (!p.requires_typed_name || name.trim().length >= 2));

  const affirm = () => {
    const evidence: ConsentCardEvidence = {
      consent_kind: p.consent_kind,
      disclosure_version_id: p.disclosure_version_id,
      method: p.affirmation_method,
      text_hash: textHash(bodyText),
      affirmed_at: nowIso(),
      party_id: card.party_id,
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      typed_name: p.requires_typed_name ? name.trim() : undefined,
    };
    void onResolve({ evidence, option_id: "affirm" });
  };

  const stateLine =
    p.consent_kind === "esign" && p.verification_state === "pending_verification"
      ? copy("consent.esign.pending")
      : p.consent_kind === "esign" && p.verification_state === "active"
        ? copy("consent.esign.active")
        : undefined;

  return (
    <CardFrame card={card} timezone={timezone} title={heading} receipt={`${heading} — ${p.verification_state === "pending_verification" ? "pending verification — check your email" : "affirmed"}`} announce={stateLine}>
      {helperText ? <p>{helperText}</p> : null}
      {p.elements?.length || p.optional_statement_copy_key ? <ConsentElements elements={p.elements ?? []} optionalStatementCopyKey={p.optional_statement_copy_key} /> : null}
      <div className="sm-card-block" data-testid="consent-body">
        {p.phone_number ? <p className="sm-primary-text sm-num">{p.phone_number}</p> : null}
        <p className="sm-primary-text" style={{ whiteSpace: "pre-wrap" }}>
          {bodyText}
        </p>
      </div>
      {stateLine ? <p className="sm-primary-text">{stateLine}</p> : null}
      {pending ? (
        <>
          {!singleTap ? (
            <>
              <label className="sm-check" htmlFor={`${id}-check`}>
                <input id={`${id}-check`} type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                <span>I have read and agree to the statement above.</span>
              </label>
              {p.requires_typed_name ? (
                <div style={{ marginTop: 8 }}>
                  <label className="sm-label" htmlFor={`${id}-name`}>
                    Type your full name to sign
                  </label>
                  <input id={`${id}-name`} className="sm-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
                </div>
              ) : null}
            </>
          ) : null}
          <div className="sm-card-actions">
            <button type="button" className="sm-btn sm-btn-primary" onClick={affirm} disabled={!ready || busy}>
              {singleTap ? "Got it" : "Agree"}
            </button>
          </div>
        </>
      ) : null}
      {footerText ? <p className="sm-card-footer">{footerText}</p> : null}
      {error ? <p className="sm-error" role="alert">{error}</p> : null}
    </CardFrame>
  );
}
