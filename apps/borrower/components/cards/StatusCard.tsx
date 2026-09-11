"use client";

import { CardFrame } from "./CardFrame";
import type { CardComponentProps } from "./types";
import { formatDate } from "@/lib/format";
import { copy } from "@/lib/copy";
import { statusDetailLines } from "@/components/flows/7-closing";
import { withTokenKeys } from "@/components/flows/11-rate-watch";

/** 01 §3.1 — tell the borrower what just happened and what happens next. No action. */
export function StatusCard({ card, timezone }: CardComponentProps<"StatusCard">) {
  const { next_event_label, next_event_at, copy_tokens } = card.props;
  // 32.7: detail lines the server names by copy key (`funded.no_skip`; the signing package list), after any literal `detail`
  const details = statusDetailLines(withTokenKeys(card.props));   // 32.11 §6: `copy_token_keys` / `autopay_copy_key` resolved through the library first
  // the server names the copy key (and tokens); the library holds the sentence (32.4 StatusCards leave `state_label` empty)
  const state_label = card.props.state_label || copy(card.copy_key, copy_tokens);
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
      {details.map((d, i) => (
        <p key={i} data-testid="status-detail">
          {d}
        </p>
      ))}
    </CardFrame>
  );
}
