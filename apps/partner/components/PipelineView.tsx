"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { formatDateTime, plural } from "@/lib/format";
import type { PartnerPipeline } from "@/lib/types";
import { ErrorLine } from "@/components/Shell";
import { LoanLink, StageChip } from "@/components/ui";

export function PipelineView() {
  const [feed, setFeed] = useState<PartnerPipeline | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.pipeline().then(setFeed).catch(setError); }, []);
  if (error) return <ErrorLine error={error} />;
  if (!feed) return <p className="note">Loading…</p>;
  return (
    <div data-testid="pipeline">
      <div className="page-head"><h1>Pipeline</h1><span className="sub">{plural(feed.items.length, "member", "members")} in motion — newest first</span></div>
      <div className="table-wrap">
        <table data-testid="pipeline-table">
          <thead><tr><th>Loan</th><th>Homeowner</th><th>State</th><th>Stage</th><th className="num">Days in stage</th><th>Entered</th><th>Missing</th></tr></thead>
          <tbody>
            {feed.items.length ? feed.items.map((i) => (
              <tr key={i.loan_id} data-testid="pipeline-row" data-loan-id={i.loan_id}>
                <td><LoanLink loanId={i.loan_id} last4={i.servicer_loan_last4} /></td><td>{i.homeowner.legal_name ?? "—"}</td><td>{i.state ?? "—"}</td>
                <td><StageChip stage={i.stage} /></td><td className="num">{i.days_in_stage}</td><td>{formatDateTime(i.entered_at)}</td><td className="wrap">{i.missing?.length ? i.missing.join(", ") : "—"}</td>
              </tr>
            )) : <tr><td colSpan={7} className="wrap"><span className="note">No member is in a refinance right now. A member joins the feed when an offer goes out.</span></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
