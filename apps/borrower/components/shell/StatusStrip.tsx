"use client";

import type { BorrowerRecord } from "@/lib/types/record";
import { StatusBadgeView } from "@/components/record/sections";
import { formatDate, plural } from "@/lib/format";

/** < 768: pinned under the header — status badge · next event · "N needed from you" → opens the Record as a bottom sheet (01 §1.2). */
export function StatusStrip({ record, onOpen }: { record?: BorrowerRecord; onOpen: () => void }) {
  const count = record?.needed_from_you.length ?? 0;
  return (
    <button type="button" className="sm-strip" data-testid="status-strip" onClick={onOpen} aria-label="Open your record" aria-haspopup="dialog">
      <StatusBadgeView badge={record?.status.badge ?? "Getting started"} />
      <span className="sm-strip-next" data-testid="strip-next">
        {record?.next ? (
          <>
            {record.next.label} <time dateTime={record.next.due_at}>{formatDate(record.next.due_at, record.timezone)}</time>
          </>
        ) : (
          "Nothing scheduled"
        )}
      </span>
      <span className="sm-strip-count" data-testid="strip-count">
        {count > 0 ? `${plural(count, "item", "items")} needed` : "0 needed"}
      </span>
    </button>
  );
}
