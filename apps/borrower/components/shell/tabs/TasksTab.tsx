"use client";

import type { BorrowerRecord } from "@/lib/types/record";
import { copy } from "@/lib/copy";
import { formatDate } from "@/lib/format";

/** needed_from_you only. Completing an item opens Chat and focuses the card on the record sheet.
 * Zero items is the record's own nothing-needed state (`needed_summary.copy_key` = `needs.none`, 32.13-T15), from the copy library. */
export function TasksTab({
  record,
  onOpenTask,
}: {
  record?: BorrowerRecord;
  onOpenTask: (cardInstanceId: string) => void;
}) {
  const needed = record?.needed_from_you ?? [];
  const empty = copy(record?.needed_summary?.nothing_needed ? record.needed_summary.copy_key : "needs.none");
  const caption = record?.journey_progress
    ? `${record.header.purpose} · ${record.journey_progress.done} of ${record.journey_progress.total}`
    : record?.status
      ? `${record.header.purpose} · ${record.status.badge}`
      : null;

  return (
    <div className="sm-tab-page" data-testid="tab-page-tasks">
      <h1 className="sm-tab-title">Tasks</h1>
      <h2 className="sm-tab-section-label">Needed from you</h2>
      {needed.length === 0 ? (
        <p className="sm-tab-muted" data-testid="tasks-empty">
          {empty}
        </p>
      ) : (
        <ul className="sm-list">
          {needed.map((n) => (
            <li key={n.item_id}>
              <button type="button" className="sm-linkbtn" onClick={() => onOpenTask(n.card_instance_id)}>
                {n.label}
              </button>
              <span className="sm-muted">
                {n.kind}
                {n.due_at ? ` · ${formatDate(n.due_at, record?.timezone ?? "America/Phoenix")}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {caption ? <p className="sm-tab-caption">{caption}</p> : null}
    </div>
  );
}
