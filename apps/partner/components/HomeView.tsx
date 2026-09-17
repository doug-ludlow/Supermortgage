"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api/client";
import { formatDate, plural } from "@/lib/format";
import type { PartnerHome } from "@/lib/types";
import { ErrorLine, useMe } from "@/components/Shell";
import { Tile } from "@/components/ui";

export function HomeView() {
  const me = useMe();
  const [home, setHome] = useState<PartnerHome | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.home().then(setHome).catch(setError); }, []);
  if (error) return <ErrorLine error={error} />;
  if (!home) return <p className="note">Loading…</p>;
  const canReadReports = me.roles.includes("partner_admin") || me.roles.includes("partner_auditor");
  return (
    <div data-testid="home" data-empty={home.empty ? "true" : "false"}>
      <div className="page-head">
        <h1>Home</h1>
        <span className="sub">{home.partner.legal_name}{home.partner.nmlsr_id ? ` · NMLSR ID ${home.partner.nmlsr_id}` : ""}{home.as_of_date ? ` · board as of ${formatDate(home.as_of_date)}` : ""}</span>
      </div>
      {home.empty ? (
        <div className="empty" data-testid="home-empty">{home.copy} <Link href="/book">Go to Book</Link></div>
      ) : (
        <>
          <h2>Book</h2>
          <div className="tiles">
            <Tile label="Last tape as of" value={formatDate(home.book.last_as_of)} small href="/book" testId="home-last-as-of" />
            <Tile label="Next tape due" value={<>{formatDate(home.book.next_tape_due)} {home.book.late ? <span className="chip bad" data-testid="home-late">Late</span> : null}</>} small href="/book" testId="home-next-due" />
            <Tile label="Monitored loans" value={home.book.loans_monitored} href="/eligibility" testId="home-monitored" />
            <Tile label="On hold" value={home.book.on_hold} href="/book#holds" testId="home-on-hold" />
          </div>
          <h2>Eligibility</h2>
          <div className="tiles">
            <Tile label="Eligible now" value={home.eligibility.eligible_now} href="/eligibility?bucket=eligible_now" testId="home-eligible-now" />
            <Tile label="Likely soon" value={home.eligibility.likely_soon} href="/eligibility?bucket=likely_soon" testId="home-likely-soon" />
            <Tile label="Not near" value={home.eligibility.not_near} href="/eligibility?bucket=not_near" testId="home-not-near" />
          </div>
          <h2>Pipeline</h2>
          <div className="tiles">
            <Tile label="In flight" value={home.pipeline.in_flight} href="/pipeline" testId="home-in-flight" />
            <Tile label="Boarded this month" value={home.pipeline.boarded_mtd} href="/pipeline" testId="home-boarded-mtd" />
          </div>
          <h2>Reports</h2>
          <div className="panel" data-testid="home-report">
            {home.latest_report_id && home.latest_report_as_of
              ? (canReadReports ? <Link href={`/reports?as_of=${encodeURIComponent(home.latest_report_as_of)}`}>Latest daily report — {formatDate(home.latest_report_as_of)}</Link> : <span>Latest daily report — {formatDate(home.latest_report_as_of)} (read by partner admins and auditors)</span>)
              : <span className="note">No daily report yet: the first is produced after the first daily review.</span>}
            <p className="note">{plural(home.book.imports, "import", "imports")} on the book.</p>
          </div>
        </>
      )}
    </div>
  );
}
