"use client";

import type { BorrowerRecord } from "@/lib/types/record";
import { copy } from "@/lib/copy";
import { formatMoney, formatRate } from "@/lib/format";

/** Origination glance from borrower_record. Journey is progress only — not a checklist of invented steps. */
export function ApplyTab({
  record,
  onOpenTask,
}: {
  record?: BorrowerRecord;
  onOpenTask: (cardInstanceId: string) => void;
}) {
  const journey = record?.journey_progress;
  const numbers = record?.numbers;
  const pre = numbers?.phase === "pre_funding" ? numbers : undefined;
  const needed = record?.needed_from_you ?? [];

  return (
    <div className="sm-tab-page" data-testid="tab-page-apply">
      <h1 className="sm-tab-title">Apply</h1>
      <p className="sm-tab-lede">{record?.header.purpose ?? "Application"} · {record?.header.loan_label ?? "No file yet"}</p>
      {record?.status ? (
        <p className="sm-tab-status">
          <span className="sm-badge" data-tone="info">
            <span>○</span> {record.status.badge}
          </span>
          <span className="sm-tab-muted">{copy(record.status.one_liner, record.status.one_liner_tokens)}</span>
        </p>
      ) : (
        <p className="sm-tab-muted">Sign in to start or continue an application.</p>
      )}
      {journey ? (
        <section className="sm-record-section">
          <h2>Progress</h2>
          <p className="sm-tab-muted">
            {journey.done} of {journey.total}
          </p>
          <ol className="sm-list">
            {journey.steps.map((s) => (
              <li key={s.id}>
                <span>{copy(s.label_copy_key)}</span>
                <span className="sm-muted">{s.state}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {pre ? (
        <section className="sm-record-section">
          <h2>Figures</h2>
          <dl className="sm-kv">
            {pre.note_rate ? (
              <>
                <dt>Rate</dt>
                <dd>{formatRate(pre.note_rate)}</dd>
              </>
            ) : null}
            {pre.loan_amount_cents ? (
              <>
                <dt>Loan amount</dt>
                <dd className="sm-num">{formatMoney(pre.loan_amount_cents)}</dd>
              </>
            ) : null}
            {pre.pi_payment_cents ? (
              <>
                <dt>P&amp;I</dt>
                <dd className="sm-num">{formatMoney(pre.pi_payment_cents)}</dd>
              </>
            ) : null}
          </dl>
          {pre.footer ? <p className="sm-tab-muted">{pre.footer}</p> : null}
        </section>
      ) : null}
      <section className="sm-record-section">
        <h2>Needed from you</h2>
        {needed.length === 0 ? (
          <p className="sm-tab-muted">Nothing needed right now.</p>
        ) : (
          <ul className="sm-list">
            {needed.map((n) => (
              <li key={n.item_id}>
                <button type="button" className="sm-linkbtn" onClick={() => onOpenTask(n.card_instance_id)}>
                  {n.label}
                </button>
                <span className="sm-muted">{n.kind}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
