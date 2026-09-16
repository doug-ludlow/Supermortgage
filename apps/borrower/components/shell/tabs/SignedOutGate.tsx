"use client";

/** Signed-out body for a tab that needs a session. Does not replace the shell. */
export function SignedOutGate({ title, onSignIn }: { title: string; onSignIn: () => void }) {
  return (
    <div className="sm-tab-page" data-testid="signed-out-gate">
      <h1 className="sm-tab-title">{title}</h1>
      <p className="sm-tab-lede">Sign in to see this. Your loan stays on these tabs after you do.</p>
      <button type="button" className="sm-btn sm-btn-primary" onClick={onSignIn}>
        Sign in
      </button>
    </div>
  );
}
