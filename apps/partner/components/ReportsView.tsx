"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, ApiRequestError } from "@/lib/api/client";
import { formatDate, formatDateTime } from "@/lib/format";
import type { DailyReport } from "@/lib/types";
import { ErrorLine, useMe } from "@/components/Shell";

export function ReportsView() {
  const me = useMe();
  const search = useSearchParams();
  const canExport = me.roles.includes("partner_admin") || me.roles.includes("partner_auditor");
  const [reports, setReports] = useState<DailyReport[] | null>(null);
  const [asOf, setAsOf] = useState<string | null>(search.get("as_of"));
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.reports().then((r) => { setReports(r.reports); setAsOf((cur) => cur ?? r.reports[0]?.as_of_date ?? null); }).catch(setError); }, []);
  if (error instanceof ApiRequestError && error.status === 403) return <div data-testid="reports-refused"><div className="page-head"><h1>Reports</h1></div><div className="empty">The daily report is read by partner admins and auditors. This account holds {me.roles.join(", ")}.</div></div>;
  if (error) return <ErrorLine error={error} />;
  if (!reports) return <p className="note">Loading…</p>;
  const r = reports.find((x) => x.as_of_date === asOf) ?? reports[0] ?? null;
  return (
    <div data-testid="reports">
      <div className="page-head"><h1>Reports</h1><span className="sub">The daily examiner report — one row per day, produced by the platform after the daily review</span></div>
      {!r ? <div className="empty">No daily report yet: the first is produced after the first daily review.</div> : (
        <>
          <div className="tabs" role="tablist">
            {reports.slice(0, 14).map((x) => <button key={x.id} role="tab" type="button" aria-selected={x.id === r.id} onClick={() => setAsOf(x.as_of_date)}>{formatDate(x.as_of_date)}</button>)}
          </div>
          <div className="panel" data-testid="report" data-report-id={r.id}>
            <p style={{ marginTop: 0 }}><strong>{formatDate(r.as_of_date)}</strong> · produced by {r.produced_by} at {formatDateTime(r.created_at)} · report <code>{r.id}</code>{r.decision_id ? <> · decision <code>{r.decision_id}</code></> : null}</p>
            {canExport ? <p data-testid="report-export"><a className="btn secondary" href={api.exportUrl(r.as_of_date, "json")} download>Export JSON</a> <a className="btn secondary" href={api.exportUrl(r.as_of_date, "csv")} download>Export CSV</a></p> : null}
            <h3>Review</h3>
            {r.review.absent ? <p className="note">No review receipt for the day.</p> : null}
            <dl className="facts">
              <dt>Reviewed</dt><dd>{r.review.reviewed}</dd><dt>Candidates</dt><dd>{r.review.candidates}</dd><dt>Watching</dt><dd>{r.review.watching}</dd><dt>Not now</dt><dd>{r.review.not_now}</dd><dt>Excluded</dt><dd>{r.review.excluded}</dd>
              <dt>Offers delivered</dt><dd>{r.review.offers_delivered} ({r.review.offers_portal_only} portal only)</dd><dt>Expired</dt><dd>{r.review.expired}</dd><dt>Analyst turns</dt><dd>{r.review.analyst_turns} ({r.review.analyst_skipped} skipped)</dd>
              <dt>Fair-lending extract</dt><dd>{r.review.fair_lending_extract_id ? <code>{r.review.fair_lending_extract_id}</code> : "—"}</dd>
            </dl>
            <h3>Readiness</h3>
            <dl className="facts"><dt>Checked</dt><dd>{r.readiness.checked}</dd><dt>Ready</dt><dd>{r.readiness.ready}</dd><dt>Not ready</dt><dd>{r.readiness.not_ready}</dd><dt>Applications opened</dt><dd>{r.readiness.applications_opened}</dd><dt>DU runs</dt><dd>{r.readiness.du_runs}</dd></dl>
            <h3>Book</h3>
            <dl className="facts"><dt>Monitored</dt><dd>{r.book.loans_monitored}</dd><dt>On hold</dt><dd>{r.book.on_hold}</dd><dt>Paid off</dt><dd>{r.book.paid_off}</dd><dt>Transferred out</dt><dd>{r.book.transferred_out}</dd><dt>Imports</dt><dd>{r.book.imports}</dd><dt>Last tape as of</dt><dd>{formatDate(r.book.last_as_of_date)}</dd><dt>Next expected</dt><dd>{formatDate(r.book.next_expected)}</dd></dl>
          </div>
        </>
      )}
    </div>
  );
}
