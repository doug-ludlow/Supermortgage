"use client";

import { CardFrame, nowIso } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { OfferCardEvidence, OfferDecision } from "@/lib/types/cards";
import { copy, copyOptions } from "@/lib/copy";
import { formatDate, formatMoney, formatRate } from "@/lib/format";
import { offerLines } from "@/components/flows/11-rate-watch";

/** 01 §3.15 — the refinance offer; O1.2 creative structure; Yes / Not now / Never. */
export function OfferCard({ card, timezone, onResolve, busy, error }: CardComponentProps<"OfferCard">) {
  const p = card.props;
  const pending = card.status === "pending";
  const labels = copyOptions("offer.card");
  const decision = (card.evidence as OfferCardEvidence | undefined)?.decision;
  const options: { id: OfferDecision; label: string }[] = [
    { id: "yes", label: labels[0] ?? "Yes, let's do it" },
    { id: "not_now", label: labels[1] ?? "Not now" },
    { id: "never", label: labels[2] ?? "Never" },
  ];

  const pick = (d: OfferDecision) => {
    const evidence: OfferCardEvidence = { decision: d, decided_at: nowIso() };
    void onResolve({ evidence, option_id: d });
  };

  const receipt = decision === "not_now" ? copy("offer.not_now") : decision === "never" ? copy("offer.never") : decision === "yes" ? "Offer accepted — starting your application" : undefined;

  return (
    <CardFrame card={card} timezone={timezone} title={`Lower your rate to ${formatRate(p.offered_rate)}`} receipt={receipt} announce={receipt}>
      <div className="sm-offer-rates">
        <div className="sm-card-block">
          <div className="sm-source">Your rate now</div>
          <div className="sm-big">{formatRate(p.current_rate)}</div>
        </div>
        <div className="sm-card-block">
          <div className="sm-source">Offered rate · APR {formatRate(p.apr)}</div>
          <div className="sm-big sm-positive-text">{formatRate(p.offered_rate)}</div>
        </div>
      </div>
      <dl className="sm-kv" style={{ marginTop: 10 }}>
        <dt>New principal & interest</dt>
        <dd>{formatMoney(p.new_pi_payment_cents)}/mo</dd>
        <dt>Monthly savings</dt>
        <dd className="sm-positive-text">{formatMoney(p.monthly_savings_cents)}/mo</dd>
        <dt>Costs to you</dt>
        <dd>{formatMoney(p.costs_to_borrower_cents)}</dd>
        <dt>Offer good through</dt>
        <dd>
          <time dateTime={p.expires_at}>{formatDate(p.expires_at, timezone)}</time>
        </dd>
      </dl>
      {/* 32.11 §2: the LE-style payment statement and the cost line, from the library */}
      {offerLines(p).map((line, i) => (
        <p key={i} data-testid="offer-line">
          {line}
        </p>
      ))}
      {pending ? (
        <div className="sm-options" role="group" aria-label="Your answer">
          {options.map((o) => (
            <button key={o.id} type="button" className={`sm-btn sm-option${o.id === "yes" ? " sm-btn-primary" : ""}`} onClick={() => pick(o.id)} disabled={busy} aria-pressed={decision === o.id}>
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
      <p className="sm-card-footer">
        {p.not_a_commitment_text} {p.rates_change_daily_text} {p.lender_legal_name}. {p.mlo_name}, NMLSR ID {p.mlo_nmlsr_id}.
      </p>
      {error ? <p className="sm-error" role="alert">{error}</p> : null}
    </CardFrame>
  );
}
