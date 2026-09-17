import { Suspense } from "react";
import { Door } from "@/components/Door";

export const dynamic = "force-dynamic";

/** 36.1: the door — the code to the e-mail, then the password (set at enrolment); the partner's legal name on the door from public config. No loan list before auth. */
export default function SignInPage() {
  return (
    <Suspense fallback={<div className="door"><div className="card"><p className="note">Opening…</p></div></div>}>
      <Door partnerLegalName={process.env.NEXT_PUBLIC_PARTNER_LEGAL_NAME ?? null} partnerNmlsrId={process.env.NEXT_PUBLIC_PARTNER_NMLSR_ID ?? null} />
    </Suspense>
  );
}
