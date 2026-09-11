"use client";

/**
 * 32.4 §5 — the "What changed" block of a revised Loan Estimate: the diff of rows between le_v{n−1} and le_v{n}
 * (rate, points, payment, cash to close, specific fees) computed by the API from the two figure snapshots, never free
 * text. Money renders from cents with Intl.NumberFormat; rates as decimal strings; the changed-circumstance kind is the
 * copy library's plain-language label.
 */
import type { WhatChanged as WhatChangedBlock, WhatChangedRow } from "@/lib/types/cards";
import { copy } from "@/lib/copy";
import { formatMoney, formatRate } from "@/lib/format";

export function rowLabel(r: WhatChangedRow): string {
  return r.label ?? (r.label_key ? copy(r.label_key) : r.key);
}
export function rowValue(r: WhatChangedRow, side: "from" | "to"): string {
  const v = r[side];
  if (v === null || v === undefined) return "—";
  return r.unit === "rate" ? formatRate(v) : formatMoney(v);
}

export function WhatChanged({ block }: { block: WhatChangedBlock }) {
  // 32.7 §1: the LE→CD diff titles itself `cd.what_changed`; a revised LE keeps `le.what_changed`
  const title = copy(block.title_key ?? "le.what_changed");
  return (
    <section className="sm-card-block" data-testid="what-changed" aria-label={title}>
      <h4 style={{ margin: "0 0 6px" }}>{title}</h4>
      {block.kind_copy_key ? (
        <p className="sm-source" data-testid="what-changed-kind">
          {copy(block.kind_copy_key)}
        </p>
      ) : null}
      {block.rows.length === 0 ? (
        <p className="sm-muted">No figure changed.</p>
      ) : (
        <table className="sm-diff" data-testid="what-changed-rows">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Was</th>
              <th scope="col">Now</th>
            </tr>
          </thead>
          <tbody>
            {block.rows.map((r) => (
              <tr key={r.key} data-row-key={r.key}>
                <th scope="row">{rowLabel(r)}</th>
                <td className="sm-num" data-side="from">
                  {rowValue(r, "from")}
                </td>
                <td className="sm-num" data-side="to">
                  {rowValue(r, "to")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
