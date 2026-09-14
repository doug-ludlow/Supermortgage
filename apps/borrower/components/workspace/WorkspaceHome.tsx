"use client";

/**
 * docs/ux/18 W1 — Workspace Home: post-auth default. Loan glance (never behind a collapsed
 * Record section), Approvals (pending card_instances → existing Card + resolveCard),
 * What's happening (status / what_we_are_doing / partner_book.review; honest empty),
 * shortcuts (Pay / Statements / Documents / Application when relevant), Guide entry
 * is in the header / drawer. No second commit path.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AnyCardInstance, ResolveRequest } from "@/lib/types/cards";
import type { BorrowerRecord, NeededItem } from "@/lib/types/record";
import type { CardComponentProps } from "@/components/cards/types";
import { Card } from "@/components/cards";
import { CardBoundary } from "@/components/flows/13-cross-cutting/CardBoundary";
import { StatusBadgeView } from "@/components/record/sections";
import { neededRows } from "@/components/record/Rail";
import { cardTitle } from "@/components/shell/chips";
import { copy, copyOrUndefined } from "@/lib/copy";
import { formatDate, formatMoney, formatRate, withinDays } from "@/lib/format";

export type WorkspaceHomeProps = {
  record?: BorrowerRecord;
  cards: Record<string, AnyCardInstance>;
  timezone: string;
  cardProps: Pick<CardComponentProps<"StatusCard">, "onOpen" | "onLaunchVendor" | "onUpload" | "onMessage">;
  resolve: (card: AnyCardInstance, req: ResolveRequest) => Promise<void>;
  busyCardId?: string;
  cardErrors: Record<string, string>;
  currentAskId?: string;
  focus?: { card_instance_id: string; seq: number };
  onOpenGuide: () => void;
  onFocusCard: (card_instance_id: string) => void;
  onOpenRecord: () => void;
  onOpenDocument: (document_id: string) => void;
};

function hasSubject(record: BorrowerRecord | undefined): boolean {
  return !!(record?.subject.loan_id || record?.subject.application_id);
}

function servicerOf(record: BorrowerRecord | undefined): string {
  const named = record?.partner_book?.partner_name;
  if (named) return named;
  const tok = record?.status.one_liner_tokens?.servicer;
  if (typeof tok === "string" && tok) return tok;
  return "";
}

function isMonitored(record: BorrowerRecord | undefined): boolean {
  return record?.partner_book?.monitored === true || record?.status.badge === "Monitored";
}

function autodraftOn(record: BorrowerRecord | undefined): boolean | undefined {
  if (!record || isMonitored(record)) return undefined;
  if (record.numbers?.phase !== "post_funding") return undefined;
  const st = record.loan?.autodraft?.status;
  if (!st) return false;
  return st === "active" || st === "authorized" || st === "validating";
}

export function WorkspaceHome({
  record,
  cards,
  timezone,
  cardProps,
  resolve,
  busyCardId,
  cardErrors,
  currentAskId,
  focus,
  onOpenGuide,
  onFocusCard,
  onOpenRecord,
  onOpenDocument,
}: WorkspaceHomeProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [panel, setPanel] = useState<"docs" | "pay-none" | undefined>();
  const needed = useMemo(() => neededRows(record, cards, currentAskId), [record, cards, currentAskId]);

  useEffect(() => {
    if (!focus) return;
    setExpanded((e) => ({ ...e, [focus.card_instance_id]: true }));
    const t = setTimeout(() => {
      document.getElementById(`rail-${focus.card_instance_id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 30);
    return () => clearTimeout(t);
  }, [focus]);

  const isExpanded = (id: string | undefined, dflt = false): boolean => (id ? (expanded[id] ?? dflt) : false);
  const toggle = (id: string) => setExpanded((e) => ({ ...e, [id]: !(e[id] ?? id === currentAskId) }));

  const renderCard = (c: AnyCardInstance) => (
    <CardBoundary card={c}>
      <Card card={c} timezone={timezone} {...cardProps} onResolve={(req) => resolve(c, req)} busy={busyCardId === c.card_instance_id} error={cardErrors[c.card_instance_id]} />
    </CardBoundary>
  );

  const payCard = Object.values(cards).find((c) => c.kind === "PaymentCard" && c.status === "pending");
  const monitored = isMonitored(record);
  const showPay = !monitored && (!!payCard || record?.numbers?.phase === "post_funding");
  const showApplication = !!record?.subject.application_id;
  const showDocuments = (record?.documents.length ?? 0) > 0 || Object.values(cards).some((c) => c.kind === "DocumentCard" || c.kind === "NoticeCard");
  const showStatements = showDocuments && (record?.numbers?.phase === "post_funding" || (record?.documents.some((d) => /statement|1098|stmt/i.test(d.kind) || /STMT|1098/i.test(d.notice_code ?? "")) ?? false));
  const autopay = autodraftOn(record);
  const partner = servicerOf(record);

  return (
    <div className="sm-workspace" data-testid="workspace-home">
      <header className="sm-workspace-head">
        <h1 data-testid="workspace-title">{copy("workspace.home.title")}</h1>
        <p className="sm-muted">{copy("workspace.home.subtitle")}</p>
      </header>

      <LoanGlance record={record} timezone={timezone} autopay={autopay} partner={partner} monitored={monitored} />

      <section className="sm-workspace-block" data-testid="workspace-approvals" aria-labelledby="ws-approvals">
        <h2 id="ws-approvals">{copy("workspace.approvals.title")}</h2>
        {needed.length === 0 ? (
          <p className="sm-muted" data-testid="workspace-approvals-empty">
            {copy("workspace.approvals.empty")}
          </p>
        ) : (
          <ul className="sm-rail-list">
            {needed.map((row) => {
              const label =
                (row.item ? copyOrUndefined(row.item.label_copy_key, row.item.copy_tokens) : undefined) ??
                (row.card && (!row.item?.label || row.item.label === row.card.copy_key) ? cardTitle(row.card) : row.item?.label) ??
                (row.card ? cardTitle(row.card) : row.id);
              return <ApprovalRow key={row.id} row={row} label={label} timezone={timezone} current={!!row.card && row.card.card_instance_id === currentAskId} expanded={isExpanded(row.card?.card_instance_id, row.card?.card_instance_id === currentAskId)} onToggle={() => row.card && toggle(row.card.card_instance_id)}>{row.card ? renderCard(row.card) : null}</ApprovalRow>;
            })}
          </ul>
        )}
      </section>

      <Happening record={record} partner={partner} />

      <section className="sm-workspace-block" data-testid="workspace-shortcuts" aria-labelledby="ws-shortcuts">
        <h2 id="ws-shortcuts">{copy("workspace.shortcuts.title")}</h2>
        <div className="sm-workspace-shortcuts">
          {showPay ? (
            <button type="button" className="sm-btn" data-testid="shortcut-pay" onClick={() => {
              if (payCard) onFocusCard(payCard.card_instance_id);
              else setPanel("pay-none");
            }}>
              {copy("workspace.shortcuts.pay")}
            </button>
          ) : null}
          {showStatements ? (
            <button type="button" className="sm-btn" data-testid="shortcut-statements" onClick={() => setPanel("docs")}>
              {copy("workspace.shortcuts.statements")}
            </button>
          ) : null}
          {showDocuments ? (
            <button type="button" className="sm-btn" data-testid="shortcut-documents" onClick={() => setPanel("docs")}>
              {copy("workspace.shortcuts.documents")}
            </button>
          ) : null}
          {showApplication ? (
            <button type="button" className="sm-btn" data-testid="shortcut-application" onClick={() => {
              const first = needed[0]?.card?.card_instance_id;
              if (first) onFocusCard(first);
              else onOpenRecord();
            }}>
              {copy("workspace.shortcuts.application")}
            </button>
          ) : null}
          <button type="button" className="sm-btn sm-btn-quiet" data-testid="shortcut-guide" onClick={onOpenGuide}>
            {copy("workspace.guide.open")}
          </button>
        </div>
        {monitored ? (
          <p className="sm-muted" data-testid="workspace-no-pay">
            {copy("workspace.shortcuts.no_pay_partner", { servicer: partner })}
          </p>
        ) : null}
        {panel === "pay-none" ? (
          <p className="sm-muted" data-testid="workspace-pay-none">
            {copy("workspace.pay.none")}
          </p>
        ) : null}
        {panel === "docs" ? <DocumentsList record={record} onOpen={onOpenDocument} /> : null}
      </section>
    </div>
  );
}

function LoanGlance({ record, timezone, autopay, partner, monitored }: { record?: BorrowerRecord; timezone: string; autopay?: boolean; partner: string; monitored: boolean }) {
  if (!hasSubject(record) || !record) {
    return (
      <section className="sm-workspace-block" data-testid="workspace-glance" data-empty="true">
        <h2>{copy("workspace.glance.title")}</h2>
        <p className="sm-muted">{copy("workspace.glance.empty")}</p>
      </section>
    );
  }
  const n = record.numbers;
  const line = copy(record.status.one_liner, { ...record.status.one_liner_tokens, servicer: partner });
  return (
    <section className="sm-workspace-block sm-glance" data-testid="workspace-glance" data-monitored={monitored ? "true" : undefined}>
      <h2>{copy("workspace.glance.title")}</h2>
      <p className="sm-glance-head">
        <StatusBadgeView badge={record.status.badge} oneLiner={line} />
        <span className="sm-source">{record.header.address_line || record.header.loan_label}</span>
      </p>
      <p className="sm-primary-text" data-testid="workspace-status-line">
        {line}
      </p>
      {n ? (
        <dl className="sm-kv sm-glance-numbers" data-testid="workspace-numbers">
          {n.phase === "post_funding" ? (
            <>
              {n.upb_cents ? (
                <>
                  <dt>{copy("workspace.glance.balance")}</dt>
                  <dd className="sm-big sm-num">{formatMoney(n.upb_cents)}</dd>
                </>
              ) : null}
              {n.note_rate ? (
                <>
                  <dt>{copy("workspace.glance.rate")}</dt>
                  <dd className="sm-num">{formatRate(n.note_rate)}</dd>
                </>
              ) : null}
              {n.next_payment ? (
                <>
                  <dt>{copy("workspace.glance.next_payment")}</dt>
                  <dd className="sm-num">{formatMoney(n.next_payment.amount_cents)}</dd>
                  {n.next_payment.due_on ? (
                    <>
                      <dt>{copy("workspace.glance.due")}</dt>
                      <dd>
                        <time dateTime={n.next_payment.due_on}>{formatDate(`${n.next_payment.due_on}T12:00:00Z`, timezone === "UTC" ? "UTC" : timezone)}</time>
                      </dd>
                    </>
                  ) : null}
                </>
              ) : null}
            </>
          ) : (
            <>
              {n.note_rate ? (
                <>
                  <dt>{copy("workspace.glance.rate")}</dt>
                  <dd className="sm-big sm-num">{formatRate(n.note_rate)}</dd>
                </>
              ) : null}
              {n.pi_payment_cents ? (
                <>
                  <dt>{copy("workspace.glance.pi")}</dt>
                  <dd className="sm-num">{formatMoney(n.pi_payment_cents)}</dd>
                </>
              ) : null}
              {n.loan_amount_cents ? (
                <>
                  <dt>{copy("workspace.glance.loan_amount")}</dt>
                  <dd className="sm-num">{formatMoney(n.loan_amount_cents)}</dd>
                </>
              ) : null}
              {n.lock.status && n.lock.status !== "none" ? (
                <>
                  <dt>{copy("workspace.glance.lock")}</dt>
                  <dd>{n.lock.status}{n.lock.expires_at ? ` · ${formatDate(n.lock.expires_at, timezone)}` : ""}</dd>
                </>
              ) : null}
            </>
          )}
        </dl>
      ) : null}
      {autopay === true ? (
        <p className="sm-muted" data-testid="workspace-autopay">{copy("workspace.glance.autopay_on")}</p>
      ) : null}
      {autopay === false ? (
        <p className="sm-muted" data-testid="workspace-autopay">{copy("workspace.glance.autopay_off")}</p>
      ) : null}
    </section>
  );
}

function Happening({ record, partner }: { record?: BorrowerRecord; partner: string }) {
  const doing = record?.what_we_are_doing ?? [];
  const review = record?.partner_book?.review;
  const statusLine = record ? copy(record.status.one_liner, { ...record.status.one_liner_tokens, servicer: partner }) : "";
  const rows: { id: string; text: string }[] = [];
  const seen = new Set<string>();
  if (review) {
    for (const key of [review.outcome ? `refi.review.${review.outcome}` : "", ...(review.reasons_copy_keys ?? [])]) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const text = copy(key);
      if (text && text !== key) rows.push({ id: key, text });
    }
  }
  for (const item of doing) rows.push({ id: item.item_id, text: item.label });
  if (rows.length === 0 && statusLine && record?.status.one_liner) rows.push({ id: "status", text: statusLine });
  return (
    <section className="sm-workspace-block" data-testid="workspace-happening" aria-labelledby="ws-happening">
      <h2 id="ws-happening">{copy("workspace.happening.title")}</h2>
      {rows.length === 0 ? (
        <p className="sm-muted" data-testid="workspace-happening-empty">
          {copy("workspace.happening.empty")}
        </p>
      ) : (
        <ul className="sm-list" data-testid="workspace-happening-list">
          {rows.map((r) => (
            <li key={r.id}>{r.text}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DocumentsList({ record, onOpen }: { record?: BorrowerRecord; onOpen: (id: string) => void }) {
  const docs = record?.documents ?? [];
  return (
    <div className="sm-workspace-docs" data-testid="workspace-documents">
      <h3>{copy("workspace.documents.title")}</h3>
      {docs.length === 0 ? (
        <p className="sm-muted">{copy("workspace.documents.empty")}</p>
      ) : (
        <ul className="sm-list">
          {docs.map((d) => (
            <li key={d.document_id}>
              <button type="button" className="sm-linkbtn" onClick={() => onOpen(d.document_id)}>
                {d.title}
              </button>
              <span className="sm-muted">{d.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ApprovalRow({
  row,
  label,
  timezone,
  current,
  expanded,
  onToggle,
  children,
}: {
  row: { card?: AnyCardInstance; item?: NeededItem; id: string };
  label: string;
  timezone: string;
  current?: boolean;
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  const card = row.card;
  const id = card?.card_instance_id;
  const due = row.item?.due_at ?? card?.expires_at;
  return (
    <li className="sm-rail-row" data-rail-card={id} data-card-kind={card?.kind} data-card-status={card?.status} data-expanded={expanded ? "true" : "false"} data-current-ask={current ? "true" : undefined} id={id ? `rail-${id}` : undefined}>
      {card ? (
        <button type="button" className="sm-rail-toggle" aria-expanded={expanded} onClick={onToggle}>
          <span className="sm-rail-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          <span className="sm-rail-label">{label}</span>
          {due ? (
            <time dateTime={due} className={`sm-muted${withinDays(due, 3) ? " sm-caution-text" : ""}`}>
              by {formatDate(due, timezone)}
            </time>
          ) : null}
        </button>
      ) : (
        <span className="sm-rail-toggle sm-rail-static">
          <span className="sm-rail-label">{label}</span>
        </span>
      )}
      {expanded && card ? <div className="sm-rail-card">{children}</div> : null}
    </li>
  );
}
