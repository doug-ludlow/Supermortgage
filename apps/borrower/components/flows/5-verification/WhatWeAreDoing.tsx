"use client";

/**
 * 32.5 §1 — one list, one owner per item. Needed-from-you holds only the borrower's items (`owner=you`; the strip counts
 * them). Everything else the owning process is still working — `open`, `waiting_third_party`, `satisfied_pending_review`
 * conditions — sits under "What we're doing" with its owner label from the copy library (us · the title company · the
 * appraiser · your current servicer). Nothing here is actionable: no chip, no card.
 */
import type { DoingItem } from "@/lib/types/record";
import { copy } from "@/lib/copy";

const STATUS_LABEL: Record<string, string> = { open: "In progress", waiting_third_party: "Waiting on them", satisfied_pending_review: "Received — under review", reopened: "In progress" };

export function WhatWeAreDoing({ items }: { items: DoingItem[] }) {
  if (!items.length) return null;
  return (
    <div className="sm-doing" data-testid="what-we-are-doing">
      <h3 style={{ margin: "12px 0 6px", fontSize: "1em" }}>{copy("needs.doing.title")}</h3>
      <ul className="sm-list">
        {items.map((i) => (
          <li key={i.item_id} data-owner={i.owner} data-status={i.status}>
            <span style={{ flex: 1 }}>{i.label}</span>
            <span className="sm-muted">
              {STATUS_LABEL[i.status] ?? i.status} · <span className="sm-owner">{copy(i.owner_copy_key)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
