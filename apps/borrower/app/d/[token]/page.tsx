import { DeepLink } from "@/components/shell/DeepLink";

export const dynamic = "force-dynamic";

/**
 * 01 §6.5 / 32.14 S5 deep links: /d/{token} → L1 (a code, Google or a passkey; or the existing session) → the target card
 * pinned on /app, the document, or the route. Tokens never encode loan data, so nothing about the loan renders before L1.
 */
export default async function DeepLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <DeepLink token={token} />;
}
