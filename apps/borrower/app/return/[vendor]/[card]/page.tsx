import Link from "next/link";
import { SHOW_FAKE_MARKERS } from "@/lib/env";

const VENDORS: Record<string, string> = {
  stripe: "Stripe Identity",
  plaid: "Plaid",
  truv: "Truv",
  ron: "RON platform",
  irs: "IRS IVES",
  carrier: "Carrier connection",
};

/**
 * 01 §1.5 external return: /return/{vendor}/{card_instance_id}. The vendor's client
 * callback never resolves the card (01 §3.4) — the API resolves it on the webhook. This
 * page just sends the borrower back to the pinned card. Stub until the vendors are wired.
 */
export default async function ReturnPage({ params }: { params: Promise<{ vendor: string; card: string }> }) {
  const { vendor, card } = await params;
  const label = VENDORS[vendor] ?? vendor;
  return (
    <main style={{ padding: 24, maxWidth: 560 }}>
      <h1 style={{ fontSize: "1.375rem" }}>Back from {label}</h1>
      {SHOW_FAKE_MARKERS ? (
        // FAKE: no real vendor redirected here in fixtures/dev/nonprod.
        <p>
          <span className="sm-fake">FAKE vendor · {label}</span>
        </p>
      ) : null}
      <p>Thanks — we're waiting for {label} to confirm. Your card updates on its own; nothing else is needed from you here.</p>
      <p>
        <Link className="sm-btn sm-btn-primary" href={`/?card=${encodeURIComponent(card)}`}>
          Back to your conversation
        </Link>
      </p>
    </main>
  );
}
