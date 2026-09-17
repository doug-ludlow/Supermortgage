import { Suspense } from "react";
import { Shell } from "@/components/Shell";
import { EligibilityView } from "@/components/EligibilityView";

export const dynamic = "force-dynamic";

/** 36.3: three tabs — Eligible now / Likely soon / Not near — a projection of 33.2's verdict; the state filter and no other. */
export default function EligibilityPage() {
  return <Shell><Suspense fallback={<p className="note">Loading…</p>}><EligibilityView /></Suspense></Shell>;
}
