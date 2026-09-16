"use client";

import type { BorrowerRecord } from "@/lib/types/record";
import { formatDate } from "@/lib/format";

/** The phone's next event on a tab's status line (01 §1.2): `record.next` printed verbatim — the label and its `due_at`, never a date computed here. */
export function NextEvent({ record }: { record: BorrowerRecord }) {
  return (
    <span className="sm-tab-muted" data-testid="next-event">
      {record.next ? (
        <>
          {record.next.label} <time dateTime={record.next.due_at}>{formatDate(record.next.due_at, record.timezone)}</time>
        </>
      ) : (
        "Nothing scheduled"
      )}
    </span>
  );
}
