"use client";

import { CardFrame } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { ChecklistOwner, ChecklistStatus } from "@/lib/types/cards";
import { copy } from "@/lib/copy";
import { formatDate, withinDays } from "@/lib/format";

const OWNER_LABEL: Record<ChecklistOwner, string> = { you: "You", us: "Us", third_party: "Third party" };
const STATUS_LABEL: Record<ChecklistStatus, string> = {
  open: "Open",
  waiting_borrower: "Waiting on you",
  waiting_third_party: "Waiting on a third party",
  satisfied_pending_review: "Received — under review",
  cleared: "Cleared",
  waived: "Waived",
  reopened: "Reopened",
};
const ACTION_LABEL = { upload: "Upload", connect: "Connect", explain: "Explain", schedule: "Schedule" } as const;

/** 01 §3.8 — the needs list / conditions with owners; items with owner=you open their own card. */
export function ChecklistCard({ card, timezone, onOpen }: CardComponentProps<"ChecklistCard">) {
  const p = card.props;
  const heading = p.title ?? copy(card.copy_key);
  const yours = p.items.filter((i) => i.owner === "you" && !["cleared", "waived"].includes(i.status));
  return (
    <CardFrame card={card} timezone={timezone} title={heading} collapsible={false} announce={`${yours.length} needed from you`}>
      {p.items.length === 0 ? <p>{copy("needs.none")}</p> : null}
      <ul className="sm-list sm-checklist">
        {p.items.map((i) => {
          const done = i.status === "cleared" || i.status === "waived";
          const soon = i.due_at && withinDays(i.due_at, 3);
          return (
            <li key={i.condition_id} data-status={i.status}>
              <span style={{ flex: 1 }}>
                <span aria-hidden="true">{done ? "✓ " : i.status === "satisfied_pending_review" ? "◐ " : "○ "}</span>
                {i.label}
                <span className="sm-muted">
                  {" "}
                  · {STATUS_LABEL[i.status]}
                  {i.due_at ? (
                    <>
                      {" · due "}
                      <time dateTime={i.due_at} className={soon ? "sm-caution-text" : undefined}>
                        {formatDate(i.due_at, timezone)}
                      </time>
                    </>
                  ) : null}
                </span>
              </span>
              <span className="sm-owner" data-owner={i.owner}>
                {OWNER_LABEL[i.owner]}
              </span>
              {i.owner === "you" && !done && i.action ? (
                <button type="button" className="sm-btn" style={{ minHeight: 36, padding: "4px 10px" }} onClick={() => onOpen?.({ card_instance_id: i.action?.card_instance_id })}>
                  {ACTION_LABEL[i.action.kind]}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </CardFrame>
  );
}
