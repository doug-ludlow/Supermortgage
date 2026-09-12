"use client";

/**
 * 32.16 §2.1 — the thread is the conversation: plain assistant lines and borrower lines (and a human's turns), day dividers,
 * reference chips and confirm chips. No card component renders here at any width (T11): a message that put a card on the
 * rail shows a one-line reference chip that focuses and expands it there (below 768 px the rail is the bottom sheet and the
 * chip opens it), and a resolved card's chip shows its receipt (T12). No sender label, no "automated" badge, no timestamp
 * on every line — provenance (01 §1.3) is an aria/hover detail, and the disclosure row (`{{copy:entry.disclosure.first}}`,
 * the session's first row) is not rendered in the log: the footer is the disclosure (§1 principle 8). A reply carrying
 * `copy_tokens.element = "rates"` renders the rates element the app draws from its tokens (T7). Agent lines arrive with their
 * tokens already filled and render as text.
 *
 * A slim "Waiting on you: {{label}} →" line sits under the header only while the borrower has scrolled away from the
 * current ask's reference (§2.1); it focuses the card on the rail.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AnyCardInstance, CardProposal, ResolveRequest } from "@/lib/types/cards";
import type { ThreadMessage } from "@/lib/types/record";
import { civilDate, dayDividerLabel, formatDate } from "@/lib/format";
import { copy } from "@/lib/copy";
import { MessageBody } from "@/components/flows/3-entry";
import { packageMembers } from "@/components/flows/4-disclosures";
import { ConfirmChip, ReferenceChip, cardTitle } from "./chips";
import { RatesElement, isRatesElement } from "./RatesElement";

export type ThreadProps = {
  messages: ThreadMessage[];
  cards: Record<string, AnyCardInstance>;
  timezone: string;
  partnerLegalName: string;
  showSubjectLabels: boolean;
  scrollTo?: string; // message_id to scroll into view
  /** The current ask on the rail (Needed from you, first row): the slim waiting line names it when its reference is scrolled away. */
  currentAskId?: string;
  /** Focus and expand a card on the rail (a reference chip, the waiting line, a confirm chip's Edit). */
  onOpenCard?: (card_instance_id: string) => void;
  /** Confirm on a confirm chip: the same `resolveCard` the rail uses. */
  resolve: (card: AnyCardInstance, req: ResolveRequest) => Promise<void>;
  busyCardId?: string;
  cardErrors: Record<string, string>;
  /** A load/connection problem, shown above the log (never as a card). */
  notice?: string;
  /** 32.14 S3: a non-blocking prompt above the scrollback (the `auth.add_mobile` ConfirmCard after Google). */
  banner?: ReactNode;
};

/** The disclosure row (32.3 E2) is the session's first row on the API; the app renders it as the footer, never in the log (32.16 §2.0). */
export const DISCLOSURE_REF = "{{copy:entry.disclosure.first}}";
export const isDisclosureRow = (m: ThreadMessage): boolean => (m.body_text ?? "").trim() === DISCLOSURE_REF && !m.card_instance_id;

/** The current ask: the named card while pending, else the record's first needed item, else the most recent pending card (01 §1.3). */
export function currentAsk(cards: Record<string, AnyCardInstance>, neededFirst?: string, pinnedId?: string): AnyCardInstance | undefined {
  const named = pinnedId ? cards[pinnedId] : undefined;
  if (named && named.status === "pending") return named;
  const needed = neededFirst ? cards[neededFirst] : undefined;
  if (needed && needed.status === "pending") return needed;
  return Object.values(cards)
    .filter((c) => c.status === "pending")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
}

const proposalOf = (c: AnyCardInstance | undefined): CardProposal | undefined => {
  const p = c && c.status === "pending" ? ((c.props as { proposal?: CardProposal }).proposal ?? undefined) : undefined;
  return p && ((p.fields && p.fields.length > 0) || p.option_id) ? p : undefined;
};

export function Thread({ messages, cards, timezone, partnerLegalName, showSubjectLabels, scrollTo, currentAskId, onOpenCard, resolve, busyCardId, cardErrors, notice, banner }: ThreadProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);

  const sorted = useMemo(() => [...messages].filter((m) => !isDisclosureRow(m)).sort((a, b) => (a.at < b.at ? -1 : 1)), [messages]);
  // the message that put the current ask on the rail (the latest one carrying that card)
  const askMessageId = useMemo(() => (currentAskId ? [...sorted].reverse().find((m) => m.card_instance_id === currentAskId)?.message_id : undefined), [sorted, currentAskId]);

  const measure = useCallback(() => {
    const s = scroller.current;
    if (!s || !askMessageId) {
      setAway(false);
      return;
    }
    const el = document.getElementById(`msg-${askMessageId}`);
    if (!el) {
      setAway(false);
      return;
    }
    const box = el.getBoundingClientRect();
    const view = s.getBoundingClientRect();
    setAway(box.bottom < view.top || box.top > view.bottom);
  }, [askMessageId]);

  useEffect(() => {
    // keep the newest message in view as the thread grows (declared first: a scroll target set on the same render wins below)
    const s = scroller.current;
    if (s) s.scrollTop = s.scrollHeight;
    measure();
  }, [messages.length, measure]);

  useEffect(() => {
    if (!scrollTo) return;
    const el = document.getElementById(`msg-${scrollTo}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    (el as HTMLElement | null)?.focus?.();
  }, [scrollTo]);

  const ask = currentAskId ? cards[currentAskId] : undefined;
  // 32.4 §2: the LE and its companions are one grouped reference — the package's chips render at its first message; the members render nothing of their own
  const packages = useMemo(() => packageMembers(sorted, cards), [sorted, cards]);
  // §3.4: every pending card the model proposed into reads back as a confirm chip at the foot of the log — the latest exchange
  const proposals = useMemo(() => Object.values(cards).map((card) => ({ card, proposal: proposalOf(card) })).filter((x): x is { card: AnyCardInstance; proposal: CardProposal } => !!x.proposal).sort((a, b) => (a.proposal.proposed_at ?? "").localeCompare(b.proposal.proposed_at ?? "")), [cards]);

  return (
    <>
      <div className="sm-thread-top">
        {notice ? (
          <p className="sm-error" role="alert" style={{ margin: 0, padding: "8px 16px" }}>
            {notice}
          </p>
        ) : null}
        {banner}
        {ask && ask.status === "pending" && away ? (
          <div className="sm-waiting" data-testid="waiting-on-you" data-card-id={ask.card_instance_id}>
            <button type="button" className="sm-linkbtn" onClick={() => onOpenCard?.(ask.card_instance_id)}>
              {copy("rail.waiting_on_you", { label: cardTitle(ask) })}
            </button>
          </div>
        ) : null}
      </div>
      <div ref={scroller} className="sm-thread-scroll" role="log" aria-label="Conversation" data-testid="thread" onScroll={measure}>
        {sorted.map((m, i) => {
          const prev = sorted[i - 1];
          const newDay = !prev || civilDate(prev.at, timezone) !== civilDate(m.at, timezone);
          const card = m.card_instance_id ? cards[m.card_instance_id] : undefined;
          const pkg = packages.get(m.message_id);
          if (pkg?.role === "member") return null;
          const who = m.sender === "borrower" ? "You" : m.sender === "notice" ? "Notice" : m.sender_label;
          const provenance = `${who} · ${formatDate(m.at, timezone, "time")}${m.voice_turn ? " · voice" : ""}${m.channel !== "app" ? ` · ${m.channel}` : ""}`;
          const rates = isRatesElement(m.copy_tokens) ? m.copy_tokens : undefined;
          return (
            <Fragment key={m.message_id}>
              {newDay ? (
                <div className="sm-day" role="separator">
                  <span>{dayDividerLabel(m.at, timezone)}</span>
                </div>
              ) : null}
              <div id={`msg-${m.message_id}`} className={`sm-msg${m.sender === "borrower" ? " sm-msg-borrower" : ""}${m.sender === "notice" ? " sm-msg-notice" : ""}${m.sender === "human" ? " sm-msg-human" : ""}`} tabIndex={-1} data-sender={m.sender} title={provenance}>
                <span className="sm-visually-hidden" data-testid="provenance">
                  {provenance}
                  {showSubjectLabels && m.subject.label ? ` · ${m.subject.label}` : ""}
                </span>
                {m.body_text ? (
                  <div className="sm-msg-body">
                    <MessageBody text={m.body_text} partnerLegalName={partnerLegalName} tokens={m.copy_tokens} />
                  </div>
                ) : null}
                {rates ? <RatesElement tokens={rates} timezone={timezone} /> : null}
                {pkg?.role === "head" ? (
                  <div className="sm-package" data-testid="disclosure-package" data-package-id={pkg.package_id}>
                    <p className="sm-primary-text" data-testid="disclosure-package-header" style={{ margin: "0 0 4px" }}>
                      {copy("le.package", { count: String(pkg.cards.filter((c) => c.kind === "DocumentCard" && c.props.disclosure_id !== pkg.package_id).length) })}
                    </p>
                    {pkg.cards.map((c) => (
                      <ReferenceChip key={c.card_instance_id} card={c} timezone={timezone} onOpen={(id) => onOpenCard?.(id)} />
                    ))}
                  </div>
                ) : card ? (
                  <ReferenceChip card={card} timezone={timezone} onOpen={(id) => onOpenCard?.(id)} />
                ) : null}
              </div>
            </Fragment>
          );
        })}
        {proposals.length ? (
          <div className="sm-thread-chips" data-testid="confirm-chips">
            {proposals.map(({ card, proposal }) => (
              <ConfirmChip key={card.card_instance_id} card={card} proposal={proposal} busy={busyCardId === card.card_instance_id} error={cardErrors[card.card_instance_id]} onConfirm={(req) => void resolve(card, req)} onEdit={(id) => onOpenCard?.(id)} />
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}
