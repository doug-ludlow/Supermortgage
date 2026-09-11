"use client";

import { useState } from "react";
import { CardFrame, nowIso } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { ConfirmCardEvidence, ConfirmSource } from "@/lib/types/cards";
import { copy } from "@/lib/copy";

const SOURCE_LABEL: Record<ConfirmSource, string> = {
  stripe_identity: "from your ID",
  credit_report: "from your credit report",
  payroll_connection: "from your payroll connection",
  asset_report: "from your bank",
  public_records: "from public records",
  avm: "our estimate",
  recorded_instrument: "from county records",
  prior_application: "from your earlier application",
  servicing_record: "from your loan record",
  document_extraction: "from your contract",
  borrower: "you told us",
};

/** 01 §3.3 — present a fact the platform already holds and take explicit confirmation (O2.1 rule 1). */
export function ConfirmCard({ card, timezone, onResolve, busy, error }: CardComponentProps<"ConfirmCard">) {
  const { fields, title, commits_to } = card.props;
  const heading = title || copy(card.copy_key, card.props.copy_tokens);
  const helper = card.props.helper_copy_key ? copy(card.props.helper_copy_key, card.props.copy_tokens) : undefined;
  const options = card.props.options;
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.path, f.value])));
  const pending = card.status === "pending";

  const confirm = () => {
    const edited = fields.some((f) => values[f.path] !== f.value);
    const evidence: ConfirmCardEvidence = {
      fields: fields.map((f) => ({ path: f.path, value_confirmed: values[f.path] ?? f.value, source: f.source, confirmed_at: nowIso() })),
      edited,
    };
    void onResolve({ evidence });
  };

  return (
    <CardFrame card={card} timezone={timezone} title={heading} receipt={`${heading} — confirmed`} announce={pending ? undefined : "Confirmed"}>
      {helper ? (
        <p className="sm-source" data-testid="confirm-helper">
          {helper}
        </p>
      ) : null}
      <dl className="sm-fields" data-commits-to={commits_to}>
        {fields.map((f) => (
          <div key={f.path}>
            <dt>
              {f.label} <span className="sm-source">({SOURCE_LABEL[f.source]})</span>
            </dt>
            <dd>
              {editing && pending ? (
                <input className="sm-input" aria-label={f.label} value={values[f.path] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.path]: e.target.value }))} />
              ) : (
                <span className="sm-num">{values[f.path]}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {pending && options?.length ? (
        <div className="sm-card-actions">
          {options.map((o) => (
            <button key={o.id} type="button" className={`sm-btn${o.is_primary ? " sm-btn-primary" : ""}`} onClick={() => void onResolve({ option_id: o.id, evidence: { fields: fields.map((f) => ({ path: f.path, value_confirmed: values[f.path] ?? f.value, source: f.source, confirmed_at: nowIso() })), edited: false } })} disabled={busy}>
              {o.label}
            </button>
          ))}
        </div>
      ) : pending ? (
        <div className="sm-card-actions">
          <button type="button" className="sm-btn sm-btn-primary" onClick={confirm} disabled={busy}>
            Confirm
          </button>
          <button type="button" className="sm-btn" onClick={() => setEditing((e) => !e)} disabled={busy} aria-pressed={editing}>
            {editing ? "Done editing" : "Edit"}
          </button>
        </div>
      ) : null}
      {error ? <p className="sm-error" role="alert">{error}</p> : null}
    </CardFrame>
  );
}
