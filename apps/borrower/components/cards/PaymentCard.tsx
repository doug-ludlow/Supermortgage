"use client";

import { useId, useState } from "react";
import { CardFrame, nowIso } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { PaymentCardEvidence } from "@/lib/types/cards";
import { formatDate, formatMoney, mask4, sumCents, toCents } from "@/lib/format";
import { paymentTitle } from "@/components/flows/8-servicing-payments";

/**
 * 01 §3.12 — one-time payment, extra principal, or autopay change. Never shows a full
 * account number. Amount stays a cents string end-to-end: the input is dollars-and-cents
 * text parsed to bigint cents with string arithmetic only (no float).
 */
export function PaymentCard({ card, timezone, onResolve, busy, error }: CardComponentProps<"PaymentCard">) {
  const p = card.props;
  const id = useId();
  const pending = card.status === "pending";
  const [amountText, setAmountText] = useState(() => centsToInput(p.amount_default_cents));
  const [date, setDate] = useState(p.date_options[0] ?? "");
  const [account, setAccount] = useState(p.accounts[0]?.id ?? (p.add_account ? "new" : ""));
  const [includeLate, setIncludeLate] = useState(false);
  const [routing, setRouting] = useState("");
  const [acct, setAcct] = useState("");
  const parsed = parseDollarsToCents(amountText);
  const late = p.include_late_charge_option?.late_charge_cents;
  const total = parsed !== null ? (includeLate && late ? sumCents(parsed, late) : parsed) : null;
  const title = paymentTitle(card.copy_key, p);   // 32.8 §3.1: `payment.due` / `payment.another_way` with the server's tokens; the mode's default otherwise
  const ready = pending && total !== null && total > 0n && (p.mode === "extra_principal" || date) && (account !== "new" || (routing.length === 9 && acct.length >= 4));

  const submit = () => {
    if (total === null) return;
    const evidence: PaymentCardEvidence = { amount_cents: total.toString(), date, account_id: account, include_late_charge: includeLate, submitted_at: nowIso() };
    void onResolve({ evidence: { ...evidence, ...(account === "new" ? { new_account: { routing, account_last4: acct.slice(-4) } } : {}) }, option_id: p.mode });
  };

  const evid = card.evidence as PaymentCardEvidence | undefined;

  return (
    <CardFrame card={card} timezone={timezone} title={title} receipt={evid ? `${title} — ${formatMoney(evid.amount_cents)} on ${formatDate(evid.date, timezone)}` : undefined} announce={evid ? "Payment received — posting" : undefined}>
      {p.effect_line ? <p>{p.effect_line}</p> : null}
      <label className="sm-label" htmlFor={`${id}-amount`}>
        Amount
      </label>
      <input id={`${id}-amount`} className="sm-input sm-num" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} readOnly={!p.amount_editable || !pending} aria-invalid={parsed === null} />
      {parsed === null ? <p className="sm-error">Enter an amount like 2,314.50</p> : null}
      {p.include_late_charge_option ? (
        <label className="sm-check" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={includeLate} onChange={(e) => setIncludeLate(e.target.checked)} disabled={!pending} />
          <span>Include the late charge of {formatMoney(p.include_late_charge_option.late_charge_cents)}</span>
        </label>
      ) : null}
      {p.mode !== "extra_principal" ? (
        <>
          <label className="sm-label" htmlFor={`${id}-date`} style={{ marginTop: 8 }}>
            Payment date
          </label>
          <select id={`${id}-date`} className="sm-select" value={date} onChange={(e) => setDate(e.target.value)} disabled={!pending}>
            {p.date_options.map((d) => (
              <option key={d} value={d}>
                {formatDate(`${d}T12:00:00Z`, "UTC")}
              </option>
            ))}
          </select>
        </>
      ) : null}
      <label className="sm-label" htmlFor={`${id}-account`} style={{ marginTop: 8 }}>
        From account
      </label>
      <select id={`${id}-account`} className="sm-select" value={account} onChange={(e) => setAccount(e.target.value)} disabled={!pending}>
        {p.accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label ?? "Account"} {mask4(a.last4)}
          </option>
        ))}
        {p.add_account ? <option value="new">Add an account…</option> : null}
      </select>
      {account === "new" ? (
        <div className="sm-card-block">
          <label className="sm-label" htmlFor={`${id}-routing`}>
            Routing number
          </label>
          <input id={`${id}-routing`} className="sm-input sm-num" inputMode="numeric" value={routing} onChange={(e) => setRouting(e.target.value.replace(/\D/g, "").slice(0, 9))} />
          <label className="sm-label" htmlFor={`${id}-acct`} style={{ marginTop: 8 }}>
            Account number
          </label>
          <input id={`${id}-acct`} className="sm-input sm-num" inputMode="numeric" value={acct} onChange={(e) => setAcct(e.target.value.replace(/\D/g, "").slice(0, 17))} />
          <p className="sm-source">Verified instantly where possible; otherwise two small deposits confirm it.</p>
        </div>
      ) : null}
      {total !== null ? (
        <p className="sm-primary-text sm-num" data-testid="payment-total">
          Total: {formatMoney(total)}
        </p>
      ) : null}
      {pending ? (
        <div className="sm-card-actions">
          <button type="button" className="sm-btn sm-btn-primary" onClick={submit} disabled={!ready || busy}>
            {p.mode === "autopay_change" ? "Save autopay change" : "Pay now"}
          </button>
        </div>
      ) : null}
      <p className="sm-card-footer">A fresh sign-in code within the last 10 minutes is required before money moves.</p>
      {error ? <p className="sm-error" role="alert">{error}</p> : null}
    </CardFrame>
  );
}

/** "2314.50" / "2,314.5" / "2314" → cents string; null when malformed. String arithmetic only. */
export function parseDollarsToCents(text: string): bigint | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!m) return null;
  const whole = m[1]!;
  const frac = (m[2] ?? "").padEnd(2, "0");
  return BigInt(whole) * 100n + BigInt(frac);
}

export function centsToInput(cents: string): string {
  const c = toCents(cents);
  const abs = c < 0n ? -c : c;
  return `${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}
