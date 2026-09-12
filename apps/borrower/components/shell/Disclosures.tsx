"use client";

/**
 * 32.16 §1 principle 8 — /app/disclosures: the page the footer's "Disclosures and licenses" link opens. The lender's legal
 * name and NMLS ID (from `/me`'s `partner` when signed in, else the build's NEXT_PUBLIC_PARTNER_* values), the NMLS consumer
 * access link, and the state licenses list — a placeholder until the partner's licenses are configured, FAKE-marked wherever
 * the build shows FAKE markers.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { copy } from "@/lib/copy";
import { PARTNER_LEGAL_NAME, PARTNER_NMLSR_ID, SHOW_FAKE_MARKERS } from "@/lib/env";
import { FooterDisclosure, NMLS_CONSUMER_ACCESS_URL, type FooterPartner } from "./FooterDisclosure";

export function Disclosures() {
  const [partner, setPartner] = useState<FooterPartner>({ legal_name: PARTNER_LEGAL_NAME, nmlsr_id: PARTNER_NMLSR_ID });
  useEffect(() => {
    api.me().then((m) => setPartner({ legal_name: m.partner.legal_name || PARTNER_LEGAL_NAME, nmlsr_id: m.partner.nmlsr_id || PARTNER_NMLSR_ID })).catch(() => undefined);   // signed out: the build's partner
  }, []);
  const tokens = { "partner.legal_name": partner.legal_name ?? PARTNER_LEGAL_NAME, "partner.nmlsr_id": partner.nmlsr_id ?? PARTNER_NMLSR_ID };
  return (
    <div className="sm-page-shell" data-testid="disclosures">
      <header className="sm-header">
        <Link className="sm-brand" href="/" style={{ textDecoration: "none", color: "inherit" }}>
          Supermortgage
        </Link>
        {SHOW_FAKE_MARKERS ? (
          <span className="sm-fake-banner" data-testid="fake-banner" title="Dev mode: FAKE vendors and agents">
            FAKE dev mode
          </span>
        ) : null}
      </header>
      <main className="sm-page" aria-label={copy("disclosures.title")}>
        <section className="sm-signin" data-testid="disclosures-body">
          <h2 data-testid="disclosures-title">{copy("disclosures.title")}</h2>
          <p data-testid="disclosures-lender">{copy("disclosures.lender", tokens)}</p>
          <p>
            <a href={NMLS_CONSUMER_ACCESS_URL} rel="noopener noreferrer" target="_blank">
              {copy("disclosures.nmls")}
            </a>
          </p>
          <h3>{copy("disclosures.licenses")}</h3>
          {SHOW_FAKE_MARKERS ? (
            <p>
              <span className="sm-fake">FAKE licenses · placeholder list</span>
            </p>
          ) : null}
          <ul className="sm-list" data-testid="disclosures-licenses">
            <li>
              <span>{copy("disclosures.licenses.pending")}</span>
            </li>
          </ul>
        </section>
      </main>
      <FooterDisclosure partner={partner} />
    </div>
  );
}
