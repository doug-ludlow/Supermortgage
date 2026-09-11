"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AnyCardInstance, CardKind } from "@/lib/types/cards";
import { countdown, formatDate } from "@/lib/format";
import { SHOW_FAKE_MARKERS } from "@/lib/env";

/** Human-readable card kind label (01 §1.3): the aria-live announcement and the title fallback — never printed as a kicker above the card. */
const KIND_LABEL: Record<CardKind, string> = {
  StatusCard: "Status",
  ChoiceCard: "Your choice",
  ConfirmCard: "Please confirm",
  ConnectCard: "Connect",
  ConsentCard: "Consent",
  DocumentCard: "Document",
  ComparisonCard: "Compare",
  ChecklistCard: "Needed from you",
  UploadCard: "Upload",
  ExplanationCard: "Explain",
  ScheduleCard: "Schedule",
  PaymentCard: "Payment",
  InviteCard: "Invite",
  HandoffCard: "Next step",
  OfferCard: "Offer",
  NoticeCard: "Notice",
  PersonCard: "Your contact",
  ProfileCard: "About you",
  DemographicsCard: "Demographic information",
};

export type CardFrameProps = {
  card: AnyCardInstance;
  timezone: string;
  title?: string;
  /** One-line receipt shown when the card is resolved (01 §1.3: resolved cards collapse). */
  receipt?: string;
  /** Text announced via aria-live when it changes (state transitions). */
  announce?: string;
  children: ReactNode;
  /** Cards with no action (StatusCard, PersonCard, NoticeCard…) never collapse. */
  collapsible?: boolean;
  fakeVendor?: string;
};

export function FakeVendorMarker({ vendor }: { vendor: string }) {
  if (!SHOW_FAKE_MARKERS) return null;
  // FAKE: this vendor is a test double in fixtures/dev/nonprod; the marker is required everywhere a vendor is stubbed.
  return (
    <span className="sm-fake" data-testid="fake-vendor" title={`${vendor} is a FAKE vendor in this environment`}>
      FAKE vendor · {vendor}
    </span>
  );
}

export function CardFrame({ card, timezone, title, receipt, announce, children, collapsible = true, fakeVendor }: CardFrameProps) {
  const [expanded, setExpanded] = useState(false);
  const liveRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState("");
  const first = useRef(true);

  // aria-live="polite" on state change (01 §8): announce status transitions and explicit messages.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setLive(announce ?? `${KIND_LABEL[card.kind]} ${card.status}`);
  }, [card.status, announce, card.kind]);

  const cd = card.expires_at && card.status === "pending" ? countdown(card.expires_at) : null;
  const resolved = card.status !== "pending";
  const collapsed = collapsible && resolved && !expanded;

  return (
    <article
      className="sm-card"
      data-card-kind={card.kind}
      data-card-id={card.card_instance_id}
      data-status={card.status}
      aria-labelledby={`card-${card.card_instance_id}-title`}
      tabIndex={-1}
      id={`card-${card.card_instance_id}`}
    >
      {fakeVendor || (cd && cd.under72h) || (resolved && collapsible) ? (
        <div className="sm-card-kind">
          {fakeVendor ? <FakeVendorMarker vendor={fakeVendor} /> : null}
          {cd && cd.under72h ? (
            <span className="sm-countdown" role="timer">
              <time dateTime={card.expires_at}>{cd.text}</time>
            </span>
          ) : null}
          {resolved && collapsible ? (
            <button type="button" className="sm-btn sm-btn-quiet" style={{ marginLeft: "auto", minHeight: 32, padding: "2px 8px" }} onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
              {expanded ? "Hide" : "Show"}
            </button>
          ) : null}
        </div>
      ) : null}
      <h3 id={`card-${card.card_instance_id}-title`} className={collapsed ? "sm-visually-hidden" : undefined}>
        {title ?? KIND_LABEL[card.kind]}
      </h3>
      {collapsed ? (
        <div className="sm-receipt" data-testid="card-receipt">
          {receipt ?? `${title ?? KIND_LABEL[card.kind]} — ${card.status}${card.resolved_at ? ` ${formatDate(card.resolved_at, timezone, "datetime")}` : ""}`}
        </div>
      ) : (
        children
      )}
      <div ref={liveRef} aria-live="polite" aria-atomic="true" className="sm-visually-hidden" data-testid="card-live">
        {live}
      </div>
    </article>
  );
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Stable, dependency-free hash for evidence `text_hash` fields (FNV-1a 32-bit, hex). */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a:${h.toString(16).padStart(8, "0")}`;
}
