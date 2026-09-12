"use client";

/**
 * 32.14 S5 (DELTA-14) — /app/d/{token}: GET /v1/borrower/deeplink/{token} through the proxy. No session → the API answers 401
 * and the sign-in form (32.16 §2.0: e-mail + password, or Google) renders under `auth.welcome_back` with the token retained (state here; sessionStorage across the
 * Google round trip); after the session the same call resolves the target — the card pinned on /app (`?card=`), the document,
 * or the route. 404 → `deep_link.unknown`, 410 → `deep_link.expired`, each with the sign-in offer; another party's token → the
 * API's refusal (`PARTY_SCOPE` → `error.not_yours`) and no target. `ui_events{deep_link_opened}` is written by the API.
 * Tokens never encode loan data, so nothing about the loan renders before L1 (32.13-T11: no card, no address, no amount).
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiRequestError } from "@/lib/api/client";
import { copy, copyOptions } from "@/lib/copy";
import { SHOW_FAKE_MARKERS } from "@/lib/env";
import { SignIn } from "./SignIn";

type State = { kind: "loading" } | { kind: "sign_in" } | { kind: "refused"; copyKey: string; offerSignIn: boolean } | { kind: "resolved" };

/** A route target from the API (02 §7: relative to the app) → the app's own path. */
export function appRoute(route: string): string {
  if (/^https?:\/\//.test(route)) return "/app"; // never leave the app on a token's say-so
  const r = route.startsWith("/app/") || route === "/app" ? route.slice(4) : route;
  return `/app${r.startsWith("/") ? r : `/${r}`}`;
}

export function DeepLink({ token, navigate }: { token: string; navigate?: (url: string) => void }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const go = navigate ?? ((url: string) => window.location.replace(url));

  const resolve = useCallback(async () => {
    try {
      const r = await api.deeplink(token);
      setState({ kind: "resolved" });
      const t = r.target;
      if (t.card_instance_id) go(`/app?card=${encodeURIComponent(t.card_instance_id)}`);
      else if (t.document_id) go(`/app/doc/${encodeURIComponent(t.document_id)}`);
      else if (t.route) go(appRoute(t.route));
      else go("/app");
    } catch (e) {
      if (e instanceof ApiRequestError) {
        if (e.status === 401) setState({ kind: "sign_in" });
        else if (e.status === 404) setState({ kind: "refused", copyKey: "deep_link.unknown", offerSignIn: true });
        else if (e.status === 410) setState({ kind: "refused", copyKey: "deep_link.expired", offerSignIn: true });
        else setState({ kind: "refused", copyKey: e.body.copy_key, offerSignIn: false }); // 403 PARTY_SCOPE: no target is revealed
        return;
      }
      setState({ kind: "refused", copyKey: "error.generic", offerSignIn: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  const [signInLabel = ""] = copyOptions("deep_link.unknown");
  return (
    <div className="sm-page-shell" data-testid="deep-link" data-deep-link-token={token}>
      <header className="sm-header">
        <span className="sm-brand">Supermortgage</span>
        {SHOW_FAKE_MARKERS ? (
          <span className="sm-fake-banner" data-testid="fake-banner" title="Dev mode: FAKE vendors and agents">
            FAKE dev mode
          </span>
        ) : null}
      </header>
      <main className="sm-page" aria-label="Sign in">
        {state.kind === "loading" || state.kind === "resolved" ? (
          <p className="sm-source" aria-busy="true">
            …
          </p>
        ) : null}
        {state.kind === "sign_in" ? <SignIn deepLinkToken={token} onSession={() => void resolve()} /> : null}
        {state.kind === "refused" ? (
          <section className="sm-signin" data-testid="deep-link-refused" data-copy-key={state.copyKey}>
            <p className="sm-error" role="alert">
              {copy(state.copyKey)}
            </p>
            {state.offerSignIn ? (
              <p>
                <Link className="sm-btn sm-btn-primary" href="/">
                  {signInLabel}
                </Link>
              </p>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}
