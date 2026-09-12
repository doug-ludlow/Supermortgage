"use client";

/**
 * 32.16 §1 principle 8 / §3.5 (2) / T7 — the rates element: a reply that talks about rates carries the 20.3 checked range as
 * structured data in `messages.copy_tokens` (`element: "rates"` with `product`, `low_rate`, `low_apr`, `high_rate`,
 * `high_apr`, `lender`, `nmlsr_id`, `as_of`), and the app draws it — the product, the low and the high rate each with its
 * APR beside it at equal prominence, and the lender's name and NMLSR ID as the footer (Reg Z §1026.24). Never text the
 * model or a template speaks; the figures are the tokens' own strings, shown as sent.
 */
import { copy } from "@/lib/copy";
import { formatDate } from "@/lib/format";

export type RatesTokens = Record<string, string>;

export const isRatesElement = (tokens?: Record<string, string>): tokens is RatesTokens => tokens?.element === "rates";

const pct = (v: string | undefined): string => (v === undefined || v === "" ? "" : /%$/.test(v) ? v : `${v}%`);

export function RatesElement({ tokens, timezone }: { tokens: RatesTokens; timezone: string }) {
  const asOf = tokens.as_of ? (/^\d{4}-\d{2}-\d{2}$/.test(tokens.as_of) ? formatDate(`${tokens.as_of}T12:00:00Z`, "UTC") : formatDate(tokens.as_of, timezone)) : "";
  return (
    <div className="sm-rates" data-testid="rates-element" role="group" aria-label={tokens.product ?? "Rates"}>
      <div className="sm-rates-head">
        <span className="sm-rates-product" data-testid="rates-product">{tokens.product ?? ""}</span>
        {asOf ? <span className="sm-source">{copy("rates.element.as_of", { date: asOf })}</span> : null}
      </div>
      <ul className="sm-rates-list">
        <li className="sm-num" data-testid="rates-low">{copy("rates.element.low", { rate: pct(tokens.low_rate), apr: pct(tokens.low_apr) })}</li>
        <li className="sm-num" data-testid="rates-high">{copy("rates.element.high", { rate: pct(tokens.high_rate), apr: pct(tokens.high_apr) })}</li>
      </ul>
      <p className="sm-source sm-rates-footer" data-testid="rates-footer">
        {copy("rates.element.footer", { lender: tokens.lender ?? "", nmlsr_id: tokens.nmlsr_id ?? "" })}
      </p>
    </div>
  );
}
