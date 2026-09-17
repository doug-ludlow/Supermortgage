import { Shell } from "@/components/Shell";
import { LoanView } from "@/components/LoanView";

export const dynamic = "force-dynamic";

/** 36.5 rules 4–10 and 36.6 rule 4: the two-mode loan page — the banner, the facts as of, the review history, readiness, offers; the Serviced tab visible and disabled. */
export default async function LoanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Shell><LoanView loanId={id} /></Shell>;
}
