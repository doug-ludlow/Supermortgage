"use client";

/**
 * FAKE: a dev/fixtures-only frame around the anonymous minute so the Playwright suite
 * (tests/e2e/entry.spec.ts) can drive S0–S2 with `page.route` canned lead responses before the
 * shell integration lands. Renders the shell's chrome without the Record (no subject: the Record
 * pane is hidden, the mobile status strip reads `entry.landing.getting_started`). The identity
 * slot is a visibly marked FAKE placeholder — the shell's SignIn replaces it at integration.
 * Served only at /app/entry-preview when SHOW_FAKE_MARKERS is true (app/entry-preview/page.tsx).
 */
import { StatusStrip } from "@/components/shell/StatusStrip";
import { copy, copyOptions } from "@/lib/copy";
import { AnonymousMinute } from "./AnonymousMinute";

function FakeIdentityAsk() {
  // FAKE identity slot: the real S3 chooser (SignIn) is builder B's; this stands in for it in the preview only.
  const title = copy("auth.choose_method");
  return (
    <article className="sm-card" data-testid="fake-identity-ask" aria-labelledby="fake-identity-title" data-card-kind="ChoiceCard" data-status="pending">
      <div className="sm-card-kind">
        <span>Your choice</span>
        <span className="sm-fake" data-testid="fake-identity-marker" title="FAKE: the sign-in chooser is a placeholder in this preview">
          FAKE sign-in placeholder
        </span>
      </div>
      <h3 id="fake-identity-title">{title}</h3>
      <div className="sm-options" role="group" aria-label={title}>
        {copyOptions("auth.choose_method").map((label, i) => (
          <button key={label} type="button" className={`sm-btn sm-option${i === 0 ? " sm-btn-primary" : ""}`} disabled>
            <span>{label}</span>
          </button>
        ))}
      </div>
    </article>
  );
}

export function EntryPreview() {
  return (
    <div className="sm-shell" data-testid="shell" data-fixtures="1">
      <header className="sm-header">
        <span className="sm-brand">Supermortgage</span>
        <span className="sm-fake-banner" data-testid="fake-banner" title="Entry preview: FAKE lead API (page.route), FAKE sign-in placeholder">
          FAKE dev mode · entry preview
        </span>
        <span className="sm-header-spacer" />
      </header>
      <StatusStrip record={undefined} onOpen={() => {}} />
      <div className="sm-body">
        <main className="sm-thread" aria-label="Conversation">
          <AnonymousMinute renderIdentity={() => <FakeIdentityAsk />} />
        </main>
      </div>
    </div>
  );
}
