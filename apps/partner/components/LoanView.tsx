"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api/client";
import { formatDate, formatDateTime, formatMoney, formatRate, mask4, words } from "@/lib/format";
import type { PartnerLoanDetail } from "@/lib/types";
import { ErrorLine } from "@/components/Shell";
import { BucketChip, StageChip, VerdictChip } from "@/components/ui";

/**
 * Navigation only (36.5 rule 9): to the board, the pipeline detail, the holds, the new or prior loan. No Pay, Escrow, Draft,
 * Statement, ACH, Payoff, Resolve, Exclude, Message or Re-offer control exists on any row (LOAN_MONITORED; 36.6).
 */
export function LoanView({ loanId }: { loanId: string }) {
  const [d, setD] = useState<PartnerLoanDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.loan(loanId).then(setD).catch(setError); }, [loanId]);
  if (error) return <ErrorLine error={error} />;
  if (!d) return <p className="note">Loading…</p>;
  const l = d.loan;
  const tone = l.status === "active" ? "ok" : d.bucket === "in_refinance" ? "warn" : "";
  return (
    <div data-testid="loan-page" data-loan-id={d.loan_id} data-status={l.status}>
      <div className="page-head">
        <h1>Loan {l.servicer_loan_number ?? mask4(l.servicer_loan_last4)}</h1>
        <span className="sub">{l.homeowner.legal_name ?? "—"}{l.state ? ` · ${l.state}` : ""} · <BucketChip bucket={d.bucket} onHold={l.on_hold} /> {d.pipeline_stage ? <StageChip stage={d.pipeline_stage} /> : null}</span>
      </div>
      {d.banner ? <div className={`banner ${tone}`} data-testid="loan-banner">{d.banner}</div> : (
        <div className="banner" data-testid="loan-banner-retired">{words(l.status)}{l.refinanced_by_loan_id ? <> — refinanced; <Link href={`/loans/${encodeURIComponent(l.refinanced_by_loan_id)}`}>the new loan</Link></> : null}</div>
      )}
      <div className="tabs" role="tablist" data-testid="loan-tabs">
        <button role="tab" type="button" aria-selected="true" data-testid="tab-overview">Overview</button>
        <button role="tab" type="button" aria-selected="false" disabled={d.serviced_tab.disabled} aria-disabled="true" title={d.serviced_tab.copy} data-testid="tab-serviced">Serviced</button>
      </div>
      <p className="note" data-testid="serviced-tab-copy">{d.serviced_tab.copy}</p>
      {l.on_hold && l.hold ? <div className="banner warn" data-testid="loan-hold">On hold — last on the tape of {formatDate(l.hold.last_as_of_date)}; the latest tape is {formatDate(l.hold.partner_as_of_date)}. Supermortgage staff resolve holds; nothing here does.</div> : null}

      <h2>Facts as of {formatDate(l.facts_as_of)}</h2>
      <div className="panel">
        <dl className="facts" data-testid="loan-facts">
          <dt>Status</dt><dd>{words(l.status)}</dd>
          <dt>UPB</dt><dd>{formatMoney(l.upb_cents)}</dd>
          <dt>Note rate</dt><dd>{formatRate(l.note_rate_pct)}</dd>
          <dt>P&amp;I</dt><dd>{formatMoney(l.pi_cents)}</dd>
          <dt>T&amp;I</dt><dd>{formatMoney(l.ti_cents)}</dd>
          <dt>Next due</dt><dd>{formatDate(l.next_due_date)}</dd>
          <dt>Last payment</dt><dd>{formatDate(l.last_payment_date)}</dd>
          <dt>Value</dt><dd>{formatMoney(l.value?.value_cents ?? null)}{l.value?.as_of ? ` as of ${formatDate(l.value.as_of)}` : ""}</dd>
          <dt>Servicing status</dt><dd>{words(l.servicing_status)}</dd>
          <dt>Homeowner</dt><dd>{l.homeowner.legal_name ?? "—"}{l.homeowner.email_masked ? ` · ${l.homeowner.email_masked}` : ""}{l.homeowner.phone_masked ? ` · ${l.homeowner.phone_masked}` : ""}</dd>
          <dt>Account</dt><dd>{l.account_activated ? `activated ${formatDateTime(l.activated_at)}` : "not activated"}</dd>
        </dl>
        <p className="note">
          <Link href={d.links.board}>Board</Link>{d.links.pipeline ? <> · <Link href={d.links.pipeline.replace(/^\/partners/, "")}>Pipeline detail</Link></> : null}{d.links.holds ? <> · <Link href={d.links.holds.replace(/^\/partners/, "")}>Holds</Link></> : null}
          {d.links.refinanced_by_loan_id ? <> · <Link href={`/loans/${encodeURIComponent(d.links.refinanced_by_loan_id)}`}>New loan</Link></> : null}{d.links.prior_loan_id ? <> · <Link href={`/loans/${encodeURIComponent(d.links.prior_loan_id)}`}>Prior loan</Link></> : null}
        </p>
      </div>

      <h2>Review history</h2>
      <div className="table-wrap">
        <table data-testid="loan-reviews">
          <thead><tr><th>As of</th><th>Verdict</th><th>Reasons</th><th className="num">Watch rate</th><th>Analyst's rationale</th></tr></thead>
          <tbody>
            {d.reviews.length ? d.reviews.map((r) => (
              <tr key={r.as_of_date}><td>{formatDate(r.as_of_date)}</td><td><VerdictChip verdict={r.verdict} /></td><td className="wrap">{r.reasons_in_words.join("; ") || "—"}</td><td className="num">{formatRate(r.watch_rate_pct)}</td><td className="wrap">{r.analyst_rationale ?? "—"}{r.analyst_flags.length ? <> <span className="chip muted">{r.analyst_flags.join(", ")}</span></> : null}</td></tr>
            )) : <tr><td colSpan={5} className="wrap"><span className="note">No review yet — the first daily review has not run for this loan.</span></td></tr>}
          </tbody>
        </table>
      </div>

      <h2>Readiness</h2>
      <div className="panel" data-testid="loan-readiness">
        {d.readiness ? (
          <>
            <p style={{ marginTop: 0 }}>{d.readiness.ready ? <span className="chip ok">Ready</span> : <span className="chip warn">Not ready</span>} as of {formatDate(d.readiness.as_of_date)}{d.readiness.missing.length ? <> — missing: {d.readiness.missing.join(", ")}</> : null}</p>
            <div className="table-wrap" style={{ marginBottom: 0 }}><table><thead><tr><th>Item</th><th>Status</th></tr></thead><tbody>{d.readiness.items.map((it) => <tr key={it.item}><td>{words(it.item)}</td><td><span className={`chip ${it.status === "present" ? "ok" : it.status === "missing" ? "bad" : it.status === "stale" ? "warn" : "muted"}`}>{words(it.status)}</span></td></tr>)}</tbody></table></div>
          </>
        ) : <span className="note">No readiness check yet — it runs after a homeowner's Yes.</span>}
      </div>

      <h2>Offers</h2>
      <div className="table-wrap">
        <table data-testid="loan-offers">
          <thead><tr><th>As of</th><th>Status</th><th>Delivered</th><th>Channels</th><th>Expires</th></tr></thead>
          <tbody>
            {d.offers.length ? d.offers.map((o) => (
              <tr key={o.opportunity_id}><td>{formatDate(o.as_of_date)}</td><td><span className={`chip ${o.expired ? "muted" : o.status === "engaged" ? "ok" : ""}`}>{words(o.status)}</span></td><td>{formatDateTime(o.delivered_at)}</td><td>{o.delivered_channels.join(", ") || "portal only"}</td><td>{formatDate(o.expires_at)}</td></tr>
            )) : <tr><td colSpan={5} className="wrap"><span className="note">No offer yet.</span></td></tr>}
          </tbody>
        </table>
      </div>

      <h2>Facts history</h2>
      <div className="table-wrap">
        <table data-testid="loan-facts-history">
          <thead><tr><th>Tape as of</th><th>Change</th><th>What changed</th></tr></thead>
          <tbody>
            {d.facts_history.length ? d.facts_history.map((f) => <tr key={f.import_id}><td>{formatDate(f.as_of_date)}</td><td><span className="chip muted">{words(f.change)}</span></td><td className="wrap">{f.changed.join(", ") || "—"}</td></tr>) : <tr><td colSpan={3} className="wrap"><span className="note">Never on a tape — this is the new loan Supermortgage boarded.</span></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
