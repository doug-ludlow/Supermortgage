"use client";

/**
 * 32.14 §3 (DELTA-12) — /app/auth/google/callback?code&state: Google (or FakeGoogleOidc) returns here; the page posts
 * `{action: "callback", provider: "google", code, state}` through the proxy, which sets `sm_borrower_session` on the same
 * session body as OTP verify, then resumes the thread — or the deep link kept in sessionStorage (S5). Any refusal
 * (`OIDC_EMAIL_UNVERIFIED`, `OIDC_INVALID`, a missing code) renders `auth.google.failed`; the reason is never shown.
 *
 * FAKE: with SHOW_FAKE_MARKERS the request carries `x-fake-oidc: FAKE`, the header FakeGoogleOidc requires (INTEGRATIONS=fake).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { copy, copyOptions } from "@/lib/copy";
import { SHOW_FAKE_MARKERS } from "@/lib/env";
import { takePendingDeepLink } from "@/lib/auth/passkey";
import { FooterDisclosure } from "./FooterDisclosure";

export function GoogleCallback({ navigate }: { navigate?: (url: string) => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const code = p.get("code");
    const state = p.get("state");
    if (!code || !state) {
      setFailed(true);
      return;
    }
    const go = navigate ?? ((url: string) => window.location.replace(url));
    api
      .authOidcCallback("google", code, state, { fake: SHOW_FAKE_MARKERS })
      .then(() => {
        const pending = takePendingDeepLink();
        go(pending ? `/app/d/${encodeURIComponent(pending)}` : "/app");
      })
      .catch(() => setFailed(true));
  }, [navigate]);

  const [signInLabel = ""] = copyOptions("deep_link.unknown");
  return (
    <div className="sm-page-shell" data-testid="google-callback">
      <header className="sm-header">
        <span className="sm-brand">Supermortgage</span>
        {SHOW_FAKE_MARKERS ? (
          <span className="sm-fake-banner" data-testid="fake-banner" title="Dev mode: FakeGoogleOidc stands in for Google">
            FAKE dev mode
          </span>
        ) : null}
      </header>
      <main className="sm-page" aria-label="Sign in with Google">
        {SHOW_FAKE_MARKERS ? (
          <p>
            <span className="sm-fake">FAKE Google · FakeGoogleOidc</span>
          </p>
        ) : null}
        {failed ? (
          <section className="sm-signin" data-testid="google-failed">
            <p className="sm-error" role="alert">
              {copy("auth.google.failed")}
            </p>
            <p>
              <Link className="sm-btn sm-btn-primary" href="/">
                {signInLabel}
              </Link>
            </p>
          </section>
        ) : (
          <p className="sm-source" aria-busy="true">
            …
          </p>
        )}
      </main>
      <FooterDisclosure />
    </div>
  );
}
