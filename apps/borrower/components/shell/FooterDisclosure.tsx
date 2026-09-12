"use client";

/**
 * 32.16 §1 principle 8 — the disclosure is a footer, near-identical to Rocket Mortgage's: small grey centered print outside
 * the main content on every screen (the account pages, the shell, /app/talk, the deep-link and return pages, the document
 * viewer). `footer.disclosure` carries the sentence; "here" links to the NMLS consumer access page and "Disclosures and
 * licenses" to /app/disclosures. The partner's name and NMLS ID come from `/me`'s `partner` once signed in, else from the
 * build's NEXT_PUBLIC_PARTNER_LEGAL_NAME / NEXT_PUBLIC_PARTNER_NMLSR_ID. Never a chat bubble, never a sentence in the log.
 */
import Link from "next/link";
import { copy } from "@/lib/copy";
import { PARTNER_LEGAL_NAME, PARTNER_NMLSR_ID } from "@/lib/env";

export const NMLS_CONSUMER_ACCESS_URL = "https://www.nmlsconsumeraccess.org/";
export const DISCLOSURES_PATH = "/app/disclosures";

export type FooterPartner = { legal_name?: string; nmlsr_id?: string };

/** The footer sentence split around its two links: [before, "here", between, "Disclosures and licenses", after]. */
export function footerParts(partner?: FooterPartner): { text: string; here: string; middle: string; disclosures: string; tail: string } {
  const text = copy("footer.disclosure", { "partner.legal_name": partner?.legal_name || PARTNER_LEGAL_NAME, "partner.nmlsr_id": partner?.nmlsr_id || PARTNER_NMLSR_ID });
  const here = "here";
  const disclosures = "Disclosures and licenses";
  const i = text.indexOf(`Go ${here} `);
  const j = text.lastIndexOf(disclosures);
  if (i < 0 || j < 0) return { text, here: "", middle: "", disclosures: "", tail: "" };
  return { text: text.slice(0, i + 3), here, middle: text.slice(i + 3 + here.length, j), disclosures, tail: text.slice(j + disclosures.length) };
}

export function FooterDisclosure({ partner }: { partner?: FooterPartner }) {
  const p = footerParts(partner);
  return (
    <footer className="sm-footer" data-testid="footer-disclosure" data-copy-key="footer.disclosure">
      {p.here ? (
        <p>
          {p.text}
          <a href={NMLS_CONSUMER_ACCESS_URL} rel="noopener noreferrer" target="_blank">
            {p.here}
          </a>
          {p.middle}
          <Link href="/disclosures">{p.disclosures}</Link>
          {p.tail}
        </p>
      ) : (
        <p>{p.text}</p>
      )}
    </footer>
  );
}
