import { ReturnRedirect } from "@/components/shell/ReturnRedirect";

export const dynamic = "force-dynamic";

/**
 * 01 §1.5 / 32.14 S5 external return: /return/{vendor}/{card_instance_id} → /app/?card={card_instance_id} with the card
 * pinned. The vendor's client callback never resolves the card (01 §3.4) — the API resolves it on the webhook.
 */
export default async function ReturnPage({ params }: { params: Promise<{ vendor: string; card: string }> }) {
  const { vendor, card } = await params;
  return <ReturnRedirect vendor={vendor} card={card} />;
}
