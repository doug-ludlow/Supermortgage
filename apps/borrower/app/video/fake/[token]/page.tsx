import { FakeVideoPage } from "@/components/video/FakeVideoPage";

export const dynamic = "force-dynamic";

/**
 * 32.17 discrepancy (3) — /app/video/fake/{token}: the FAKE video agent's page (FakeTavus's `conversation_url`), embedded by the call
 * pane where the vendor's room would be. `{token}` is the per-session video token the vendor would hold; `?vs=` names the session
 * for the join / leave callbacks.
 */
export default async function FakeVideoRoute({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await params;
  const sp = await searchParams;
  const vs = typeof sp.vs === "string" ? sp.vs : null;
  return <FakeVideoPage token={token} videoSessionId={vs} />;
}
