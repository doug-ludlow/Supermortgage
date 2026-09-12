"use client";

/**
 * 32.16 §2.2 (DELTA-26) — the rail: where the cards live. Sections in this order, each collapsible, each hidden when empty:
 *
 *   Progress            `journey_progress` — steps done / current / upcoming, "n of m"; a step expands to its date
 *   Needed from you     the current ask, open to its component, and any caution row the platform raised (a frozen bureau, an
 *                       expired document, a returned payment, an insurance lapse — never a toast, never a modal, T14). The other
 *                       pending cards wait behind one line, "n more after this": a card appears when it is needed, not when it
 *                       exists. Every row resolves in place through `resolveCard`.
 *   Connections         each vendor connection and its state → the `ConnectCard` or its receipt
 *   Documents           every disclosure, notice and document with status → the `DocumentCard` / `NoticeCard` with the viewer
 *                       and "Confirm receipt"
 *   What we're doing    conditions owned by us or a third party, and the status cards
 *   People              borrowers, MLO of record, notary, settlement agent, servicing team → `PersonCard` / `InviteCard`
 *   Numbers · Dates · Property · Loan   read-only, as 01 §4 rows 5, 6, 9, 10
 *
 * Connections, Documents, What we're doing and People start collapsed; a reference chip, a deep link or Edit opens the section
 * its card is homed in. A card has exactly one home (here) and any number of references. Expanding is client state;
 * resolving is the API. The rail never computes a date or a figure — every value is the projection's own string.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { AnyCardInstance, ResolveRequest } from "@/lib/types/cards";
import type { BorrowerRecord, JourneyStep, NeededItem, RecordDocument } from "@/lib/types/record";
import type { CardComponentProps } from "@/components/cards/types";
import { Card } from "@/components/cards";
import { CardBoundary } from "@/components/flows/13-cross-cutting/CardBoundary";
import { WhatWeAreDoing, PartyDeliveries } from "@/components/flows/5-verification";
import { ExitBanner } from "@/components/flows/12-exits";
import { copy, copyOrUndefined } from "@/lib/copy";
import { formatDate, plural, withinDays } from "@/lib/format";
import { cardTitle, connectionState } from "@/components/shell/chips";
import { DatesSection, HeaderSection, LoanSection, NumbersSection, PropertySection, ROLE_LABEL, Section, StatusBadgeView, docStatus, personLine, type RecordLink } from "./sections";

export type RailProps = {
  record?: BorrowerRecord;
  cards: Record<string, AnyCardInstance>;
  timezone: string;
  cardProps: Pick<CardComponentProps<"StatusCard">, "onOpen" | "onLaunchVendor" | "onUpload" | "onMessage">;
  resolve: (card: AnyCardInstance, req: ResolveRequest) => Promise<void>;
  busyCardId?: string;
  cardErrors: Record<string, string>;
  /** The current ask (first row of Needed from you, expanded by default). */
  currentAskId?: string;
  /** A card to focus: expanded, its section opened, scrolled into view (a reference chip, `?card=`, a deep link, Edit). Each new value focuses again. */
  focus?: { card_instance_id: string; seq: number };
  link: RecordLink;
};

/** Issues the platform raises render as caution rows (32.16 §2.2): the lift instructions for a frozen bureau, a stale or re-requested document, a returned payment, an insurance lapse. */
export const ISSUE_COPY_KEY = /^(credit\.freeze|upload\.(stale|rerequest)|payment\.returned|insurance\.(lapse|cancel|expired|missing)|document\.expired|escrow\.shortage)/;
export const isIssueCard = (c: AnyCardInstance): boolean => ISSUE_COPY_KEY.test(c.copy_key) || (c.kind === "NoticeCard" && ISSUE_COPY_KEY.test(String((c.props as { notice_code?: string }).notice_code ?? "").toLowerCase()));

const HOMED_ELSEWHERE = new Set(["ConnectCard", "DocumentCard", "NoticeCard", "PersonCard", "InviteCard", "StatusCard"]);
const STEP_MARK: Record<JourneyStep["state"], string> = { done: "●", current: "◐", upcoming: "○" };

/** The pending cards that belong under Needed from you, current ask first, then the record's own order, then the rest by recency. */
export function neededRows(record: BorrowerRecord | undefined, cards: Record<string, AnyCardInstance>, currentAskId?: string): { card?: AnyCardInstance; item?: NeededItem; id: string }[] {
  const pending = Object.values(cards).filter((c) => c.status === "pending");
  const out: { card?: AnyCardInstance; item?: NeededItem; id: string }[] = [];
  const seen = new Set<string>();
  const push = (card: AnyCardInstance | undefined, item: NeededItem | undefined, id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ card, item, id });
  };
  const ask = currentAskId ? cards[currentAskId] : undefined;
  if (ask && ask.status === "pending") push(ask, record?.needed_from_you.find((i) => i.card_instance_id === ask.card_instance_id), ask.card_instance_id);
  for (const item of record?.needed_from_you ?? []) {
    const card = item.card_instance_id ? cards[item.card_instance_id] : undefined;
    if (card && card.status !== "pending") continue;
    push(card, item, card?.card_instance_id ?? item.item_id);
  }
  for (const c of pending.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))) {
    if (HOMED_ELSEWHERE.has(c.kind) && !isIssueCard(c)) continue; // a pending ConnectCard is still needed: the record lists it; other kinds live in their own sections
    if (c.kind === "ConnectCard") { const st = (c.props as { state?: string }).state; if (st && !["not_started", "failed", "in_progress"].includes(st)) continue; }
    push(c, undefined, c.card_instance_id);
  }
  return out;
}

/** The section a card is homed in (32.16 §2.2): the focus target's section opens so the card is in view. */
export function homeOf(card: AnyCardInstance | undefined, needed: boolean): "needed" | "connections" | "documents" | "doing" | "people" | null {
  if (!card) return null;
  if (needed) return "needed";
  if (card.kind === "ConnectCard") return "connections";
  if (card.kind === "DocumentCard" || card.kind === "NoticeCard") return "documents";
  if (card.kind === "StatusCard") return "doing";
  if (card.kind === "PersonCard" || card.kind === "InviteCard") return "people";
  return card.status === "pending" ? "needed" : null;
}

/** One card's row: its one home on the rail (`rail-<card_instance_id>` is the focus target); expanded, the existing component renders in place. */
function CardRow({ card, label, due, timezone, tone, current, expanded, onToggle, children, hint }: { card?: AnyCardInstance; label: string; due?: string; timezone: string; tone?: "caution"; current?: boolean; expanded: boolean; onToggle: () => void; children?: ReactNode; hint?: string }) {
  const id = card?.card_instance_id;
  return (
    <li className="sm-rail-row" data-rail-card={id} data-card-kind={card?.kind} data-card-status={card?.status} data-expanded={expanded ? "true" : "false"} data-tone={tone} data-current-ask={current ? "true" : undefined} id={id ? `rail-${id}` : undefined}>
      {card ? (
        <button type="button" className="sm-rail-toggle" aria-expanded={expanded} onClick={onToggle}>
          <span className="sm-rail-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          <span className="sm-rail-label">{label}</span>
          {hint ? <span className="sm-muted">{hint}</span> : null}
          {due ? (
            <time dateTime={due} className={`sm-muted${withinDays(due, 3) ? " sm-caution-text" : ""}`}>
              by {formatDate(due, timezone)}
            </time>
          ) : null}
        </button>
      ) : (
        <span className="sm-rail-toggle sm-rail-static">
          <span className="sm-rail-label">{label}</span>
          {hint ? <span className="sm-muted">{hint}</span> : null}
          {due ? (
            <time dateTime={due} className="sm-muted">
              by {formatDate(due, timezone)}
            </time>
          ) : null}
        </span>
      )}
      {expanded && card ? <div className="sm-rail-card">{children}</div> : null}
    </li>
  );
}

export function Rail({ record, cards, timezone, cardProps, resolve, busyCardId, cardErrors, currentAskId, focus, link }: RailProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isExpanded = (id: string | undefined, dflt = false): boolean => (id ? (expanded[id] ?? dflt) : false);
  const toggle = (id: string) => setExpanded((e) => ({ ...e, [id]: !(e[id] ?? id === currentAskId) }));
  // the sections a card can be homed in: Needed from you open, the reference sections closed until a card there is focused or the heading is tapped
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const sectionOpen = (id: string, dflt: boolean): boolean => openSections[id] ?? dflt;
  const setSection = (id: string, open: boolean) => setOpenSections((o) => ({ ...o, [id]: open }));
  const [laterOpen, setLaterOpen] = useState(false);

  useEffect(() => {
    if (!focus) return;
    setExpanded((e) => ({ ...e, [focus.card_instance_id]: true }));
    const home = homeOf(cards[focus.card_instance_id], neededIdsRef.current.has(focus.card_instance_id));
    if (home) setSection(home, true);
    if (home === "needed" && laterIdsRef.current.has(focus.card_instance_id)) setLaterOpen(true);
    const t = setTimeout(() => {
      const el = document.getElementById(`rail-${focus.card_instance_id}`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      (el?.querySelector("article") as HTMLElement | null)?.focus?.();
    }, 30);
    return () => clearTimeout(t);
  }, [focus]);

  const all = useMemo(() => Object.values(cards), [cards]);
  const render = (c: AnyCardInstance) => (
    <CardBoundary card={c}>
      <Card card={c} timezone={timezone} {...cardProps} onResolve={(req) => resolve(c, req)} busy={busyCardId === c.card_instance_id} error={cardErrors[c.card_instance_id]} />
    </CardBoundary>
  );

  const needed = useMemo(() => neededRows(record, cards, currentAskId), [record, cards, currentAskId]);
  const neededIds = useMemo(() => new Set(needed.map((r) => r.card?.card_instance_id).filter(Boolean)), [needed]);
  // the current ask (the first row) and every caution row are on the rail now; the rest wait behind "n more after this"
  const neededNow = useMemo(() => needed.filter((r, i) => i === 0 || (r.card && isIssueCard(r.card))), [needed]);
  const neededLater = useMemo(() => needed.filter((r) => !neededNow.includes(r)), [needed, neededNow]);
  const neededIdsRef = useRef(neededIds); neededIdsRef.current = neededIds;
  const laterIdsRef = useRef(new Set<string>()); laterIdsRef.current = new Set(neededLater.map((r) => r.card?.card_instance_id).filter((x): x is string => !!x));
  const connections = useMemo(() => all.filter((c) => c.kind === "ConnectCard").sort((a, b) => (a.created_at < b.created_at ? 1 : -1)), [all]);
  const docCards = useMemo(() => all.filter((c) => c.kind === "DocumentCard" || c.kind === "NoticeCard"), [all]);
  const statusCards = useMemo(() => all.filter((c) => c.kind === "StatusCard" && c.status === "pending" && !isIssueCard(c)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)), [all]);
  const peopleCards = useMemo(() => all.filter((c) => c.kind === "PersonCard" || c.kind === "InviteCard").sort((a, b) => (a.created_at < b.created_at ? 1 : -1)), [all]);
  const cardForDoc = (d: RecordDocument): AnyCardInstance | undefined =>
    (d.card_instance_id ? cards[d.card_instance_id] : undefined) ??
    docCards.find((c) => {
      const p = c.props as { document_id?: string; rendered_document_id?: string; disclosure_id?: string };
      return p.document_id === d.document_id || p.rendered_document_id === d.document_id || (!!d.disclosure_id && p.disclosure_id === d.disclosure_id);
    });
  const documents = record?.documents ?? [];
  const docRowsCardIds = new Set(documents.map((d) => cardForDoc(d)?.card_instance_id).filter(Boolean));
  const orphanDocCards = docCards.filter((c) => !docRowsCardIds.has(c.card_instance_id)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const progress = record?.journey_progress ?? null;
  const doing = record?.what_we_are_doing ?? [];

  const neededRow = (row: { card?: AnyCardInstance; item?: NeededItem; id: string }) => {
    // the row's line: the item's copy-library line, else the card's own title — never the copy key the API falls back to when a card carries no `needed_label`
    const label = (row.item ? copyOrUndefined(row.item.label_copy_key, row.item.copy_tokens) : undefined) ?? (row.card && (!row.item?.label || row.item.label === row.card.copy_key) ? cardTitle(row.card) : row.item?.label) ?? (row.card ? cardTitle(row.card) : row.id);
    const due = row.item?.due_at ?? row.card?.expires_at;
    const current = !!row.card && row.card.card_instance_id === currentAskId;
    return (
      <CardRow key={row.id} card={row.card} label={label} due={due} timezone={timezone} tone={row.card && isIssueCard(row.card) ? "caution" : undefined} current={current} expanded={isExpanded(row.card?.card_instance_id, current)} onToggle={() => row.card && toggle(row.card.card_instance_id)}>
        {row.card ? render(row.card) : null}
      </CardRow>
    );
  };

  if (!record && all.length === 0) return <p className="sm-empty">Your record appears here once we know what we're doing today.</p>;

  return (
    <div className="sm-rail" data-testid="rail">
      {record ? (
        <>
          <HeaderSection r={record} />
          <div className="sm-rail-status" data-record-section="status">
            <StatusBadgeView badge={record.status.badge} />
            <ExitBanner r={record} />
          </div>
        </>
      ) : null}

      {progress && progress.total > 0 ? (
        <Section id="progress" title={copy("rail.progress.title")} aside={<span data-testid="progress-count">{copy("rail.progress.count", { done: progress.done, total: progress.total })}</span>}>
          <ol className="sm-steps" data-testid="progress-steps">
            {progress.steps.map((st) => (
              <li key={st.id} data-step-id={st.id} data-state={st.state} className="sm-step">
                <details>
                  <summary>
                    <span className="sm-step-mark" aria-hidden="true">{STEP_MARK[st.state]}</span>
                    <span className="sm-visually-hidden">{st.state}: </span>
                    <span>{copyOrUndefined(st.label_copy_key) ?? st.id}</span>
                  </summary>
                  <p className="sm-muted sm-step-at">{st.at ? formatDate(st.at, timezone, "datetime") : st.state === "current" ? "in progress" : "—"}</p>
                </details>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      <Section id="needed" title={copy("needs.title")} aside={needed.length ? <span data-testid="needed-count">({needed.length})</span> : undefined} open={sectionOpen("needed", true)} onToggle={(o) => setSection("needed", o)}>
        {needed.length === 0 ? (
          <p style={{ margin: 0 }} className="sm-primary-text" data-testid="needs-none">
            {copy("needs.none")}
          </p>
        ) : (
          <ul className="sm-rail-list" data-testid="needed-rows">
            {neededNow.map(neededRow)}
            {neededLater.length ? (
              <li className="sm-rail-row sm-rail-later" data-needed-later={neededLater.length} data-expanded={laterOpen ? "true" : "false"}>
                <button type="button" className="sm-rail-toggle" aria-expanded={laterOpen} data-testid="needs-later" onClick={() => setLaterOpen((o) => !o)}>
                  <span className="sm-rail-caret" aria-hidden="true">{laterOpen ? "▾" : "▸"}</span>
                  <span className="sm-rail-label sm-muted">{copy("needs.later", { n: String(neededLater.length) })}</span>
                </button>
                {laterOpen ? <ul className="sm-rail-list">{neededLater.map(neededRow)}</ul> : null}
              </li>
            ) : null}
          </ul>
        )}
      </Section>

      {connections.length ? (
        <Section id="connections" title={copy("rail.connections.title")} open={sectionOpen("connections", false)} onToggle={(o) => setSection("connections", o)}>
          <ul className="sm-rail-list">
            {connections.map((c) =>
              neededIds.has(c.card_instance_id) ? (
                // a connection still needed is one row under Needed from you (its home); here its state line points there
                <li key={c.card_instance_id} className="sm-rail-row" data-connection={c.card_instance_id} data-tone={(c.props as { state?: string }).state === "failed" ? "caution" : undefined}>
                  <button type="button" className="sm-rail-toggle" onClick={() => link({ card_instance_id: c.card_instance_id })}>
                    <span className="sm-rail-label">{cardTitle(c)}</span>
                    <span className="sm-muted">{connectionState(c)} →</span>
                  </button>
                </li>
              ) : (
                <CardRow key={c.card_instance_id} card={c} label={cardTitle(c)} hint={connectionState(c)} timezone={timezone} tone={(c.props as { state?: string }).state === "failed" ? "caution" : undefined} expanded={isExpanded(c.card_instance_id)} onToggle={() => toggle(c.card_instance_id)}>
                  {render(c)}
                </CardRow>
              ),
            )}
          </ul>
        </Section>
      ) : null}

      {documents.length || orphanDocCards.length ? (
        <Section id="documents" title="Documents" aside={documents.length + orphanDocCards.length ? <span>({documents.length + orphanDocCards.length})</span> : undefined} open={sectionOpen("documents", false)} onToggle={(o) => setSection("documents", o)}>
          <ul className="sm-rail-list">
            {documents.map((d) => {
              const c = cardForDoc(d);
              const status = record ? docStatus(d, record.timezone) : d.status;
              const tone = d.status === "superseded" || (c && isIssueCard(c)) ? ("caution" as const) : undefined;
              return (
                <CardRow key={d.document_id} card={c} label={d.title} hint={status} timezone={timezone} tone={tone} expanded={isExpanded(c?.card_instance_id)} onToggle={() => c && toggle(c.card_instance_id)}>
                  {c ? render(c) : null}
                  {d.deliveries?.length ? <PartyDeliveries deliveries={d.deliveries} timezone={timezone} /> : null}
                </CardRow>
              );
            })}
            {documents
              .filter((d) => !cardForDoc(d) && d.status !== "mailed" && d.status !== "pending")
              .map((d) => (
                <li key={`open-${d.document_id}`} className="sm-rail-row sm-rail-open" data-document-id={d.document_id}>
                  <button type="button" className="sm-linkbtn" onClick={() => link({ document_id: d.document_id, message_id: d.message_id })}>
                    Open {d.title}
                  </button>
                </li>
              ))}
            {orphanDocCards.map((c) => (
              <CardRow key={c.card_instance_id} card={c} label={cardTitle(c)} hint={c.status === "pending" ? undefined : c.status} timezone={timezone} tone={isIssueCard(c) ? "caution" : undefined} expanded={isExpanded(c.card_instance_id)} onToggle={() => toggle(c.card_instance_id)}>
                {render(c)}
              </CardRow>
            ))}
          </ul>
        </Section>
      ) : null}

      {doing.length || statusCards.length ? (
        <Section id="doing" title={copy("needs.doing.title")} open={sectionOpen("doing", false)} onToggle={(o) => setSection("doing", o)}>
          <WhatWeAreDoing items={doing} />
          {statusCards.length ? (
            <ul className="sm-rail-list">
              {statusCards.map((c) => (
                <CardRow key={c.card_instance_id} card={c} label={cardTitle(c)} timezone={timezone} expanded={isExpanded(c.card_instance_id)} onToggle={() => toggle(c.card_instance_id)}>
                  {render(c)}
                </CardRow>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}

      {(record?.people.length ?? 0) || peopleCards.length ? (
        <Section id="people" title="People" open={sectionOpen("people", false)} onToggle={(o) => setSection("people", o)}>
          <ul className="sm-list">
            {(record?.people ?? []).map((p) => (
              <li key={p.party_id}>
                <span>
                  {p.display_name} <span className="sm-source">· {ROLE_LABEL[p.role]}</span>
                </span>
                <span className="sm-muted">{personLine(p)}</span>
              </li>
            ))}
          </ul>
          {peopleCards.length ? (
            <ul className="sm-rail-list">
              {peopleCards.map((c) => (
                <CardRow key={c.card_instance_id} card={c} label={cardTitle(c)} timezone={timezone} expanded={isExpanded(c.card_instance_id)} onToggle={() => toggle(c.card_instance_id)}>
                  {render(c)}
                </CardRow>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}

      {record ? (
        <>
          <NumbersSection r={record} />
          <DatesSection r={record} link={link} />
          <PropertySection r={record} />
          <LoanSection r={record} />
        </>
      ) : null}
      {record && record.needed_from_you.length ? <p className="sm-visually-hidden">{plural(record.needed_from_you.length, "thing", "things")} needed from you</p> : null}
    </div>
  );
}
