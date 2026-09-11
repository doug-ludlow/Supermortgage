"use client";

import { CardFrame } from "./CardFrame";
import type { CardComponentProps } from "./types";
import { formatDate } from "@/lib/format";

/** 01 §3.1 — tell the borrower what just happened and what happens next. No action. */
export function StatusCard({ card, timezone }: CardComponentProps<"StatusCard">) {
  const { state_label, next_event_label, next_event_at, detail } = card.props;
  return (
    <CardFrame card={card} timezone={timezone} title={state_label} collapsible={false} announce={state_label}>
      {next_event_label ? (
        <p className="sm-primary-text">
          {next_event_label}
          {next_event_at ? (
            <>
              {" "}
              <time dateTime={next_event_at} className="sm-num">
                {formatDate(next_event_at, timezone)}
              </time>
            </>
          ) : null}
        </p>
      ) : null}
      {detail ? <p>{detail}</p> : null}
    </CardFrame>
  );
}
