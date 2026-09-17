import { Suspense } from "react";
import { Shell } from "@/components/Shell";
import { ReportsView } from "@/components/ReportsView";

export const dynamic = "force-dynamic";

/** 36.5 rules 2–3: the daily examiner report for the tenant (34.3's row); the export for partner_admin and partner_auditor. */
export default function ReportsPage() {
  return <Shell><Suspense fallback={<p className="note">Loading…</p>}><ReportsView /></Suspense></Shell>;
}
