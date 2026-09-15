"use client";

import { useState } from "react";
import { CardFrame, nowIso } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { ConfirmCardEvidence, ConfirmField, ConfirmSource } from "@/lib/types/cards";
import { copy } from "@/lib/copy";
import { centsToInput, parseDollarsToCents } from "./PaymentCard";

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

/** 32.3 E5: a field the card asks rather than shows — a choice, a number, a money amount, or an empty value the borrower types — renders its input without an Edit tap. */
const isAsk = (f: ConfirmField, money: ReadonlySet<string>): boolean => !!f.options || !!f.input || money.has(f.path) || f.value === "";
/** A field with `when` is shown (and required) only while the field it names holds that value (the monthly rent while "I rent" is chosen). */
const shownNow = (f: ConfirmField, values: Record<string, string>): boolean => !f.when || values[f.when.path] === f.when.equals;

/** 01 §3.3 — present a fact the platform already holds and take explicit confirmation (O2.1 rule 1); 32.3 E5 — the asks beside the facts (how you live there, months at the address) answered inline. */
export function ConfirmCard({ card, timezone, onResolve, busy, error }: CardComponentProps<"ConfirmCard">) {
  const { fields, title, commits_to } = card.props;
  const heading = title || copy(card.copy_key, card.props.copy_tokens);
  const helper = card.props.helper_copy_key ? copy(card.props.helper_copy_key, card.props.copy_tokens) : undefined;
  const options = card.props.options;
  const money = new Set(card.props.money_paths ?? []);
  const masked = new Set(card.props.masked_paths ?? []);
  const [editing, setEditing] = useState(false);
  // 32.16 §3.4 / 32.17 rule 16: a proposal (what the call heard) fills the fields it names; Confirm here sends those values, so one Confirm is enough
  const proposal = (card.props as { proposal?: { fields?: { path: string; value: string }[] } }).proposal;
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.path, proposal?.fields?.find((x) => x.path === f.path)?.value ?? f.value])));
  // money fields are typed as dollars and cents; the wire value stays a decimal string of cents (never a float)
  const [moneyText, setMoneyText] = useState<Record<string, string>>(() => Object.fromEntries(fields.filter((f) => money.has(f.path) || f.input === "money").map((f) => [f.path, /^\d+$/.test(values[f.path] ?? "") ? centsToInput(values[f.path]!) : ""])));
  const pending = card.status === "pending";
  const set = (path: string, v: string) => setValues((cur) => ({ ...cur, [path]: v }));

  const visible = fields.filter((f) => shownNow(f, values));
  // 01 §3.18: nothing is sent while a required answer is missing (the API refuses too — CARD_FIELD_REQUIRED)
  const requiredNow = [...(card.props.required_paths ?? []), ...Object.entries(card.props.required_when ?? {}).filter(([, w]) => values[w.path] === w.equals).map(([p]) => p)];
  const missing = requiredNow.filter((p) => !(values[p] ?? "").trim());

  const evidenceFields = () => visible.map((f) => ({ path: f.path, value_confirmed: values[f.path] ?? f.value, source: f.source, confirmed_at: nowIso() }));
  const confirm = () => {
    const edited = fields.some((f) => values[f.path] !== f.value);
    const evidence: ConfirmCardEvidence = { fields: evidenceFields(), edited };
    void onResolve({ evidence });
  };

  const input = (f: ConfirmField) => {
    if (f.options) {
      return (
        <select className="sm-select" aria-label={f.label} value={values[f.path] ?? ""} onChange={(e) => set(f.path, e.target.value)} disabled={busy}>
          <option value="">Choose one</option>
          {f.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    if (money.has(f.path) || f.input === "money") {
      return (
        <input
          className="sm-input"
          inputMode="decimal"
          aria-label={f.label}
          placeholder="$0.00"
          value={moneyText[f.path] ?? ""}
          onChange={(e) => {
            const text = e.target.value; setMoneyText((cur) => ({ ...cur, [f.path]: text }));
            const cents = parseDollarsToCents(text); set(f.path, cents === null ? "" : cents.toString());
          }}
          disabled={busy}
        />
      );
    }
    return <input className="sm-input" type={masked.has(f.path) ? "password" : "text"} inputMode={f.input === "number" ? "numeric" : undefined} aria-label={f.label} value={values[f.path] ?? ""} onChange={(e) => set(f.path, f.input === "number" ? e.target.value.replace(/\D/g, "") : e.target.value)} disabled={busy} />;
  };

  return (
    <CardFrame card={card} timezone={timezone} title={heading} receipt={`${heading} — confirmed`} announce={pending ? undefined : "Confirmed"}>
      {helper ? (
        <p className="sm-source" data-testid="confirm-helper">
          {helper}
        </p>
      ) : null}
      <dl className="sm-fields" data-commits-to={commits_to}>
        {visible.map((f) => (
          <div key={f.path}>
            <dt>
              {f.label} <span className="sm-source">({SOURCE_LABEL[f.source]})</span>
            </dt>
            <dd>
              {pending && (editing || isAsk(f, money)) ? input(f) : <span className="sm-num">{f.options ? (f.options.find((o) => o.id === values[f.path])?.label ?? values[f.path]) : money.has(f.path) && /^\d+$/.test(values[f.path] ?? "") ? moneyText[f.path] : values[f.path]}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {pending && options?.length ? (
        <div className="sm-card-actions">
          {options.map((o) => (
            <button key={o.id} type="button" className={`sm-btn${o.is_primary ? " sm-btn-primary" : ""}`} onClick={() => void onResolve({ option_id: o.id, evidence: { fields: evidenceFields(), edited: false } })} disabled={busy || missing.length > 0}>
              {o.label}
            </button>
          ))}
        </div>
      ) : pending ? (
        <div className="sm-card-actions">
          <button type="button" className="sm-btn sm-btn-primary" onClick={confirm} disabled={busy || missing.length > 0}>
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
