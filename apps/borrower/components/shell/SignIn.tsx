"use client";

/**
 * 32.16 §2.0 — the sign-in screen the shell and the deep-link page render on any 401, under `auth.welcome_back`: the one
 * `Account` form in its `sign_in` mode (e-mail + password, or Continue with Google — docs/ux/15 DELTA-12 unchanged). The
 * method chooser of docs/ux/15 S3/S6 (a code to a mobile or e-mail, Use my passkey) is gone with the anonymous minute
 * (docs/ux/17 §0.4): passkeys stay in the code and are not surfaced; codes are kept for e-mail verification, password reset
 * and the fresh-L1 step-up. On a session the caller decides what happens next — the proxy has already set the HttpOnly cookie
 * (`Shell` reloads; the deep-link page resolves its token).
 */
import { Account } from "@/components/account/Account";
import type { AccountSession } from "@/lib/api/account";

export type SignInSession = AccountSession;
export type { FakeGoogleIdentity } from "@/components/account/Account";
export { GoogleButton } from "@/components/account/GoogleButton";

export type SignInProps = {
  /** A deep-link token to resume after the session (kept in sessionStorage across the Google round trip). */
  deepLinkToken?: string;
  onSession: (session: SignInSession) => void;
  /** Shown as a quiet Back (the header's Sign in over a live thread). */
  onCancel?: () => void;
  /** Navigation for the Google redirect (window.location.assign unless a test injects one). */
  navigate?: (url: string) => void;
  /** Google's redirect target; defaults to this origin's /app/auth/google/callback. */
  redirectUri?: string;
  /** The partner named in the disclosure line when the form is the sign-up (not here); passed through for the shell's `me.partner`. */
  partnerLegalName?: string;
};

export function SignIn(props: SignInProps) {
  return <Account mode="sign_in" titleKey="auth.welcome_back" {...props} />;
}
