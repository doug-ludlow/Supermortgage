import { GoogleCallback } from "@/components/shell/GoogleCallback";

export const dynamic = "force-dynamic";

/** 32.14 §3 (DELTA-12): Google returns here with ?code&state; the client posts them through the proxy (which sets the session cookie) and resumes the thread or the pending deep link. */
export default function GoogleCallbackPage() {
  return <GoogleCallback />;
}
