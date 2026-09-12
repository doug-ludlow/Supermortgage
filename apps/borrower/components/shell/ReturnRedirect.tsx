"use client";

/**
 * 32.14 S5 (DELTA-14) — /app/return/{vendor}/{card_instance_id}: the vendor's client return sends the borrower back to the
 * thread with that card pinned (`/app/?card=`). The ConnectCard's state comes from the API (the vendor webhook, 32.1 §3.4),
 * never from this return. FAKE: no real vendor redirects here in fixtures/dev/nonprod — the marker says so.
 */
import Link from "next/link";
import { useEffect } from "react";
import { SHOW_FAKE_MARKERS } from "@/lib/env";
import { FooterDisclosure } from "./FooterDisclosure";

export function ReturnRedirect({ vendor, card, navigate }: { vendor: string; card: string; navigate?: (url: string) => void }) {
  const target = `/app?card=${encodeURIComponent(card)}`; // the canonical form: Next redirects /app/ to /app
  useEffect(() => {
    (navigate ?? ((url: string) => window.location.replace(url)))(target);
  }, [navigate, target]);
  return (
    <div className="sm-page-shell">
    <main className="sm-page" data-testid="vendor-return" data-vendor={vendor} data-card={card}>
      {SHOW_FAKE_MARKERS ? (
        <p>
          <span className="sm-fake">FAKE vendor · {vendor}</span>
        </p>
      ) : null}
      <p>
        <Link href={`/?card=${encodeURIComponent(card)}`}>Back to your conversation</Link>
      </p>
    </main>
    <FooterDisclosure />
    </div>
  );
}
