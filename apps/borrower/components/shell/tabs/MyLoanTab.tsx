"use client";

import type { BorrowerRecord } from "@/lib/types/record";
import { copy } from "@/lib/copy";
import { formatMoney, formatRate, mask4 } from "@/lib/format";

/** Servicing glance from borrower_record. P0 is read-only — Pay/Autopay resolve in a later PR. */
export function MyLoanTab({ record }: { record?: BorrowerRecord }) {
  const numbers = record?.numbers;
  const post = numbers?.phase === "post_funding" ? numbers : undefined;
  const loan = record?.loan;
  const offer = record?.offers?.find((o) => o.status === "offered" || o.status === "offer_ready");

  return (
    <div className="sm-tab-page" data-testid="tab-page-loan">
      <h1 className="sm-tab-title">My Loan</h1>
      <p className="sm-tab-lede">{record?.header.address_line ?? "Your loan"}</p>
      {record?.status ? (
        <p className="sm-tab-status">
          <span className="sm-badge" data-tone={record.status.badge === "Current" ? "positive" : "info"}>
            <span>○</span> {record.status.badge}
          </span>
          <span className="sm-tab-muted">{copy(record.status.one_liner, record.status.one_liner_tokens)}</span>
        </p>
      ) : (
        <p className="sm-tab-muted">No boarded loan on this session yet.</p>
      )}
      {post ? (
        <section className="sm-record-section">
          <h2>This month</h2>
          <dl className="sm-kv">
            <dt>Next payment</dt>
            <dd className="sm-big sm-num">{formatMoney(post.next_payment.amount_cents)}</dd>
            <dt>Due</dt>
            <dd>{post.next_payment.due_on}</dd>
            <dt>Unpaid principal</dt>
            <dd className="sm-num">{formatMoney(post.upb_cents)}</dd>
            <dt>Rate</dt>
            <dd>{formatRate(post.note_rate)}</dd>
          </dl>
        </section>
      ) : record?.numbers?.phase === "pre_funding" ? (
        <p className="sm-tab-muted">This file is still an application. Payment details appear after funding.</p>
      ) : null}
      {loan?.autodraft ? (
        <section className="sm-record-section">
          <h2>Autopay</h2>
          <dl className="sm-kv">
            <dt>Status</dt>
            <dd>{loan.autodraft.status}</dd>
            {loan.autodraft.next_draft_on ? (
              <>
                <dt>Next draft</dt>
                <dd>{loan.autodraft.next_draft_on}</dd>
              </>
            ) : null}
            {loan.autodraft.account_last4 ? (
              <>
                <dt>Account</dt>
                <dd>{mask4(loan.autodraft.account_last4)}</dd>
              </>
            ) : null}
          </dl>
        </section>
      ) : null}
      {loan?.ratewatch ? (
        <section className="sm-record-section">
          <h2>Rate-watch</h2>
          <dl className="sm-kv">
            <dt>Your rate</dt>
            <dd>{formatRate(loan.ratewatch.current_rate)}</dd>
            <dt>Best available</dt>
            <dd>{formatRate(loan.ratewatch.best_available_rate)}</dd>
            <dt>State</dt>
            <dd>{loan.ratewatch.state ?? "passive"}</dd>
          </dl>
        </section>
      ) : null}
      {offer ? (
        <section className="sm-record-section">
          <h2>Offer</h2>
          <p className="sm-tab-muted">
            An offer is on file ({offer.status}). Open Chat to respond — this tab does not commit.
          </p>
        </section>
      ) : null}
    </div>
  );
}
