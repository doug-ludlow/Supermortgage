"use client";

/**
 * 32.7 §6 item 2 — the autodraft authorization's displayed elements (2.3 rule: borrower, loan, account, amount and the
 * variable-amount rule, timing, first debit, company, how to revoke, date, e-sign), each labelled by copy key with the
 * value the server filled, and the "autopay is optional" statement (Reg E §1005.10(e)(1)) above the affirmation (T11).
 * Nothing is pre-checked; the card is optional and says so.
 */
import type { ConsentElement } from "@/lib/types/cards";
import { copy } from "@/lib/copy";

export function ConsentElements({ elements, optionalStatementCopyKey }: { elements: readonly ConsentElement[]; optionalStatementCopyKey?: string }) {
  return (
    <div className="sm-card-block" data-testid="consent-elements">
      {optionalStatementCopyKey ? <p className="sm-primary-text" data-testid="consent-optional">{copy(optionalStatementCopyKey)}</p> : null}
      <dl className="sm-dl">
        {elements.map((e) => (
          <div key={e.id} data-element={e.id}>
            <dt>{copy(e.label_key)}</dt>
            <dd className={e.value ? "sm-num" : "sm-muted"}>{e.value || (e.input ? "You'll enter this" : "—")}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
