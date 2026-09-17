"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api/client";
import { formatDate, formatMoney, formatRate, plural } from "@/lib/format";
import type { PartnerEligibility, PartnerLoanRow } from "@/lib/types";
import { ErrorLine } from "@/components/Shell";
import { BUCKET_WORDS, LoanLink, StageChip, Tile, VerdictChip } from "@/components/ui";

const BUCKETS = ["eligible_now", "likely_soon", "not_near"] as const;
type Bucket = (typeof BUCKETS)[number];

export function EligibilityView() {
  const search = useSearchParams();
  const initial = search.get("bucket");
  const [tab, setTab] = useState<Bucket>(BUCKETS.includes(initial as Bucket) ? (initial as Bucket) : "eligible_now");
  const [state, setState] = useState<string>("");
  const [board, setBoard] = useState<PartnerEligibility | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.eligibility(state ? `?state=${encodeURIComponent(state)}` : "").then(setBoard).catch(setError); }, [state]);
  const states = useMemo(() => [...new Set((board?.loans ?? []).map((l) => l.state).filter((s): s is string => !!s))].sort(), [board]);
  if (error) return <ErrorLine error={error} />;
  if (!board) return <p className="note">Loading…</p>;
  const rows = board.loans.filter((l) => !l.on_hold && l.bucket === tab);
  const c = board.counts;
  return (
    <div data-testid="eligibility" data-as-of={board.as_of_date ?? ""}>
      <div className="page-head"><h1>Eligibility</h1><span className="sub">{board.as_of_date ? `Board as of ${formatDate(board.as_of_date)} — the daily review's verdicts, nothing else` : "No review has run yet"}</span></div>
      <div className="tiles" data-testid="eligibility-counts">
        <Tile label="Eligible now" value={c.eligible_now} testId="count-eligible-now" />
        <Tile label="Likely soon" value={c.likely_soon} testId="count-likely-soon" />
        <Tile label="Not near" value={c.not_near} testId="count-not-near" />
        <Tile label="On hold" value={c.on_hold} href="/book#holds" testId="count-on-hold" />
      </div>
      <div className="tabs" role="tablist" data-testid="eligibility-tabs">
        {BUCKETS.map((b) => <button key={b} role="tab" type="button" aria-selected={tab === b} onClick={() => setTab(b)} data-testid={`tab-${b}`}>{BUCKET_WORDS[b]}<span className="count">{c[b]}</span></button>)}
        <label style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", fontSize: 13, color: "var(--muted)" }}>State
          <select value={state} onChange={(e) => setState(e.target.value)} data-testid="state-filter"><option value="">All</option>{states.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        </label>
      </div>
      <p className="note">{plural(rows.length, "loan", "loans")}{tab === "not_near" ? " — the reason is the engine's code, never a diagnosis" : tab === "likely_soon" ? " — the watch rate is the rate the review waits for" : ""}. <Link href="/book#holds">Holds</Link> are shown on Book.</p>
      <BucketTable rows={rows} bucket={tab} />
    </div>
  );
}

/** 36.3 rule 5's columns: loan last four, masked name, state, UPB, note rate, next due, value and its as-of, verdict, watch rate (Likely soon only), last review date. */
function BucketTable({ rows, bucket }: { rows: PartnerLoanRow[]; bucket: Bucket }) {
  return (
    <div className="table-wrap">
      <table data-testid={`bucket-table-${bucket}`}>
        <thead><tr><th>Loan</th><th>Homeowner</th><th>State</th><th className="num">UPB</th><th className="num">Note rate</th><th>Next due</th><th className="num">Value</th><th>Value as of</th><th>Verdict</th>{bucket === "likely_soon" ? <th className="num">Watch rate</th> : null}{bucket === "not_near" ? <th>Reason</th> : null}<th>Last review</th><th>Pipeline</th></tr></thead>
        <tbody>
          {rows.length ? rows.map((l) => (
            <tr key={l.loan_id} data-testid="bucket-row" data-loan-id={l.loan_id}>
              <td><LoanLink loanId={l.loan_id} last4={l.servicer_loan_last4} /></td><td>{l.homeowner.legal_name ?? "—"}</td><td>{l.state ?? "—"}</td>
              <td className="num">{formatMoney(l.upb_cents)}</td><td className="num">{formatRate(l.note_rate_pct)}</td><td>{formatDate(l.next_due_date)}</td>
              <td className="num">{formatMoney(l.value?.value_cents ?? null)}</td><td>{formatDate(l.value?.as_of ?? null)}</td>
              <td><VerdictChip verdict={l.latest_review?.verdict} /></td>
              {bucket === "likely_soon" ? <td className="num">{formatRate(l.watch_rate_pct)}</td> : null}
              {bucket === "not_near" ? <td className="wrap">{l.reasons_in_words.join("; ") || "—"}</td> : null}
              <td>{formatDate(l.latest_review?.as_of_date ?? null)}</td><td><StageChip stage={l.pipeline_stage} /></td>
            </tr>
          )) : <tr><td colSpan={13} className="wrap"><span className="note">No loan in this bucket.</span></td></tr>}
        </tbody>
      </table>
    </div>
  );
}
