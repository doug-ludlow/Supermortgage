/** Small console pieces shared by the pages: tiles, chips, the loan link, the review-verdict chip. */
import Link from "next/link";
import type { ReactNode } from "react";
import { mask4 } from "@/lib/format";

export function Tile({ label, value, href, testId, small }: { label: string; value: ReactNode; href?: string; testId?: string; small?: boolean }) {
  const body = <><span className="label">{label}</span><span className={`value${small ? " small" : ""}`} data-testid={testId}>{value}</span></>;
  return href ? <Link href={href} className="tile">{body}</Link> : <div className="tile">{body}</div>;
}

export const VERDICT_TONE: Record<string, string> = { candidate: "ok", watching: "warn", not_now: "muted", excluded: "bad" };
export const VERDICT_WORDS: Record<string, string> = { candidate: "Candidate", watching: "Watching", not_now: "Not now", excluded: "Excluded" };
export function VerdictChip({ verdict }: { verdict: string | null | undefined }) {
  if (!verdict) return <span className="chip muted">no review yet</span>;
  return <span className={`chip ${VERDICT_TONE[verdict] ?? "muted"}`}>{VERDICT_WORDS[verdict] ?? verdict}</span>;
}
export const BUCKET_WORDS: Record<string, string> = { eligible_now: "Eligible now", likely_soon: "Likely soon", not_near: "Not near", in_refinance: "In refinance", serviced: "Serviced" };
export function BucketChip({ bucket, onHold }: { bucket: string | null; onHold?: boolean }) {
  if (onHold) return <span className="chip warn">On hold</span>;
  if (!bucket) return <span className="chip muted">—</span>;
  const tone = bucket === "eligible_now" ? "ok" : bucket === "likely_soon" ? "warn" : bucket === "serviced" || bucket === "in_refinance" ? "" : "muted";
  return <span className={`chip ${tone}`}>{BUCKET_WORDS[bucket] ?? bucket}</span>;
}
export const STAGE_WORDS: Record<string, string> = { offered: "Offered", engaged: "Engaged", readiness: "Readiness", du: "DU", disclosures: "Disclosures", closing: "Closing", boarded: "Boarded", expired: "Expired", declined: "Declined", withdrawn: "Withdrawn", denied: "Denied", closed_incomplete: "Closed incomplete", approved_not_accepted: "Approved, not accepted" };
export function StageChip({ stage }: { stage: string | null }) {
  if (!stage) return <span className="chip muted">—</span>;
  const tone = stage === "boarded" ? "ok" : ["expired", "declined", "withdrawn", "denied", "closed_incomplete", "approved_not_accepted"].includes(stage) ? "muted" : "";
  return <span className={`chip ${tone}`}>{STAGE_WORDS[stage] ?? stage}</span>;
}

/** The loan page link: the servicer loan number's last four (the list mask; 36.3 rule 5). */
export function LoanLink({ loanId, last4 }: { loanId: string; last4: string }) {
  return <Link href={`/loans/${encodeURIComponent(loanId)}`} className="mono" data-testid="loan-link" data-loan-id={loanId}>{mask4(last4)}</Link>;
}
