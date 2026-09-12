"use client";

import { Fragment, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { AnyCardInstance, ResolveRequest } from "@/lib/types/cards";
import type { ThreadMessage } from "@/lib/types/record";
import { Card } from "@/components/cards";
import type { CardComponentProps } from "@/components/cards/types";
import { civilDate, dayDividerLabel, formatDate } from "@/lib/format";
import { copy } from "@/lib/copy";
import { DisclosurePackage, packageMembers } from "@/components/flows/4-disclosures/DisclosurePackage";
import { MessageBody, renderMessageBody } from "@/components/flows/3-entry";
import { CardBoundary } from "@/components/flows/13-cross-cutting/CardBoundary";   // 32.13: one failing card never blanks the thread

export type ThreadProps = {
  messages: ThreadMessage[];
  cards: Record<string, AnyCardInstance>;
  timezone: string;
  partnerLegalName: string;
  showSubjectLabels: boolean;
  wide: boolean; // ≥ 1024: ComparisonCard renders in the Record, Thread shows a stub
  scrollTo?: string; // message_id or card_instance_id to scroll into view
  cardProps: Pick<CardComponentProps<"StatusCard">, "onOpen" | "onLaunchVendor" | "onUpload">;
  resolve: (card: AnyCardInstance, req: ResolveRequest) => Promise<void>;
  busyCardId?: string;
  cardErrors: Record<string, string>;
  /** A load/connection problem, shown above the pinned ask (never as a card). */
  notice?: string;
  /** 32.14 S5: `?card=` on /app — that card is the pinned ask while pending and is scrolled into view (a deep link or a vendor return lands here). */
  pinnedId?: string;
  /** 32.14 S3: a non-blocking prompt above the scrollback (the `auth.add_mobile` ConfirmCard after Google). */
  banner?: ReactNode;
};

/** The pinned current ask: most recent unresolved card (01 §1.3). */
export function pinnedCard(cards: Record<string, AnyCardInstance>): AnyCardInstance | undefined {
  return Object.values(cards)
    .filter((c) => c.status === "pending")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
}

function cardTitle(c: AnyCardInstance): string {
  const p = c.props as Record<string, unknown>;
  return (p.title as string) || (p.state_label as string) || (p.purpose_text as string) || (p.subject as string) || copy(c.copy_key);
}

export function Thread({ messages, cards, timezone, partnerLegalName, showSubjectLabels, wide, scrollTo, cardProps, resolve, busyCardId, cardErrors, notice, pinnedId, banner }: ThreadProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useMemo(() => {
    const named = pinnedId ? cards[pinnedId] : undefined;
    return named && named.status === "pending" ? named : pinnedCard(cards);
  }, [cards, pinnedId]);

  useEffect(() => {
    // keep the newest message in view as the thread grows (declared first: a scroll target set on the same render wins below)
    const s = scroller.current;
    if (s) s.scrollTop = s.scrollHeight;
  }, [messages.length]);

  useEffect(() => {
    if (!scrollTo) return;
    const el = document.getElementById(`msg-${scrollTo}`) ?? document.getElementById(`card-${scrollTo}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    (el as HTMLElement | null)?.focus?.();
  }, [scrollTo]);

  const sorted = useMemo(() => [...messages].sort((a, b) => (a.at < b.at ? -1 : 1)), [messages]);
  // 32.4 §2: the LE and its companions are one grouped message — the package renders at its first card; the members render inside it
  const packages = useMemo(() => packageMembers(sorted, cards), [sorted, cards]);

  return (
    <>
      <div className="sm-thread-top">
        {notice ? (
          <p className="sm-error" role="alert" style={{ margin: 0, padding: "8px 16px" }}>
            {notice}
          </p>
        ) : null}
        {banner}
        <div className="sm-pinned" data-testid="pinned-ask" hidden={!pinned} data-pinned-card={pinned?.card_instance_id}>
        {pinned ? (
          <>
            <strong>Waiting on you:</strong>
            <span className="sm-pinned-label">{cardTitle(pinned)}</span>
            <button type="button" className="sm-btn" style={{ minHeight: 36, padding: "4px 10px" }} onClick={() => document.getElementById(`card-${pinned.card_instance_id}`)?.scrollIntoView({ block: "center", behavior: "smooth" })}>
              Jump to it
            </button>
          </>
        ) : null}
        </div>
      </div>
      <div ref={scroller} className="sm-thread-scroll" role="log" aria-label="Conversation" data-testid="thread">
        {sorted.map((m, i) => {
          const prev = sorted[i - 1];
          const newDay = !prev || civilDate(prev.at, timezone) !== civilDate(m.at, timezone);
          const card = m.card_instance_id ? cards[m.card_instance_id] : undefined;
          const pkg = packages.get(m.message_id);
          if (pkg?.role === "member") return null;
          // 01 §1.3 grouping: consecutive system messages within 60 s share one timestamp; cards never group.
          const grouped = !card && !!prev && !prev.card_instance_id && prev.sender === m.sender && m.sender !== "borrower" && new Date(m.at).getTime() - new Date(prev.at).getTime() < 60_000 && !newDay;
          return (
            <Fragment key={m.message_id}>
              {newDay ? (
                <div className="sm-day" role="separator">
                  <span>{dayDividerLabel(m.at, timezone)}</span>
                </div>
              ) : null}
              <div id={`msg-${m.message_id}`} className={`sm-msg${m.sender === "borrower" ? " sm-msg-borrower" : ""}${m.sender === "notice" ? " sm-msg-notice" : ""}`} tabIndex={-1} data-sender={m.sender}>
                {!grouped ? (
                  <div className="sm-msg-meta">
                    <span data-testid="provenance">{m.sender === "borrower" ? "You" : m.sender === "notice" ? "Notice" : m.sender_label}</span>
                    {m.automation_marker ? (
                      <span className="sm-automation" title={`Automated assistant for ${partnerLegalName}`}>
                        automated
                      </span>
                    ) : null}
                    {m.voice_turn ? <span className="sm-voice-tag">voice</span> : null}
                    {m.channel !== "app" ? <span className="sm-voice-tag">{m.channel}</span> : null}
                    {showSubjectLabels && m.subject.label ? <span className="sm-source">· {m.subject.label}</span> : null}
                    <time dateTime={m.at}>{formatDate(m.at, timezone, "time")}</time>
                  </div>
                ) : null}
                {m.body_text ? <div className="sm-msg-body"><MessageBody text={m.body_text} partnerLegalName={partnerLegalName} tokens={m.copy_tokens} /></div> : null}
                {pkg?.role === "head" ? (
                  <DisclosurePackage packageId={pkg.package_id} cards={pkg.cards} timezone={timezone} render={(c) => <CardBoundary card={c}><Card card={c} timezone={timezone} {...cardProps} onResolve={(req) => resolve(c, req)} busy={busyCardId === c.card_instance_id} error={cardErrors[c.card_instance_id]} comparisonStub={wide} /></CardBoundary>} />
                ) : card ? <CardBoundary card={card}><Card card={card} timezone={timezone} {...cardProps} onResolve={(req) => resolve(card, req)} busy={busyCardId === card.card_instance_id} error={cardErrors[card.card_instance_id]} comparisonStub={wide} /></CardBoundary> : null}
              </div>
            </Fragment>
          );
        })}
      </div>
    </>
  );
}
