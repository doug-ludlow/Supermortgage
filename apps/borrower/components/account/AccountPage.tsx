"use client";

/**
 * 32.16 §2.0 — the standalone account routes (/app/sign-up, /app/sign-in, /app/reset): the header chrome the deep-link and
 * Google callback pages use, the one `Account` form, and the disclosure footer (§1 principle 8). A session lands on /app (the thread, which opens with the disclosure
 * line and asks the goal).
 */
import Link from "next/link";
import { SHOW_FAKE_MARKERS } from "@/lib/env";
import { Account, type AccountMode } from "./Account";
import { FooterDisclosure } from "@/components/shell/FooterDisclosure";

const ARIA: Record<AccountMode, string> = { sign_up: "Create your account", sign_in: "Sign in", reset: "Reset your password" };

export function AccountPage({ mode }: { mode: AccountMode }) {
  return (
    <div className="sm-page-shell" data-testid="account-page">
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
      <main className="sm-page" aria-label={ARIA[mode]}>
        <Account mode={mode} />
      </main>
      <FooterDisclosure />
    </div>
  );
}
