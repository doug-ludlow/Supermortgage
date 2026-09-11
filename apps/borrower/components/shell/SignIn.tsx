"use client";

/**
 * 32.14 S3/S6 — the one sign-in screen (docs/ux/15 §2 S3, S6; §3). Sign-up is the first sign-in and there is no account form:
 * a code to a mobile or e-mail (POST /v1/borrower/auth/otp request → verify), Continue with Google (POST /v1/borrower/auth/oidc
 * start → the app navigates to `authorization_url`; Google returns to /app/auth/google/callback — DELTA-12, Authorization Code
 * + PKCE held server side), or Use my passkey, offered FIRST when this device registered one (the localStorage hint
 * lib/auth/passkey sets after a registration; 32.14-T12). The chooser is ChoiceCard-styled under `auth.choose_method` (S3, the
 * identity ask) or `auth.welcome_back` (S6: the header's Sign in and any 401). On a session the caller decides what happens
 * next — the proxy has already set the HttpOnly cookie (`Shell` reloads; the deep-link page resolves its token).
 * Every string is a copy key; the method labels are the chooser key's options.
 *
 * FAKE: outside production the API echoes the one-time code (`fake_code`, FakeEdelivery) and Google is FakeGoogleOidc — both
 * render with the `.sm-fake` marker, and a small FAKE identity form stands in for Google's consent screen (its values become the
 * `fake` hint the start call carries; the API refuses the hint outside INTEGRATIONS=fake).
 *
 * `id="otp"` on the root: 32.13-T11 waits for that selector on /app/d/{token} without a session (the one-time-code screen).
 */
import { useEffect, useId, useState, type FormEvent } from "react";
import { api, ApiRequestError } from "@/lib/api/client";
import { copy, copyExtra, copyOptions } from "@/lib/copy";
import { SHOW_FAKE_MARKERS } from "@/lib/env";
import { hasPasskeyOnDevice, passkeyAssert, setPendingDeepLink, type PasskeySession } from "@/lib/auth/passkey";

export type SignInVariant = "choose_method" | "welcome_back";
export type SignInSession = PasskeySession;
/** The FAKE identity hint FakeGoogleOidc turns into a verified (or not) Google identity. */
export type FakeGoogleIdentity = { email: string; email_verified?: boolean; name?: string; sub?: string };

export type SignInProps = {
  variant: SignInVariant;
  /** A deep-link token to resume after the session (kept in sessionStorage across the Google round trip). */
  deepLinkToken?: string;
  onSession: (session: SignInSession) => void;
  /** Shown as a quiet Back on the chooser (the header's Sign in over a live thread). */
  onCancel?: () => void;
  /** Navigation for the Google redirect (window.location.assign unless a test injects one). */
  navigate?: (url: string) => void;
  /** Google's redirect target; defaults to this origin's /app/auth/google/callback. */
  redirectUri?: string;
};

type Channel = "sms" | "email";
type CodeStep = { kind: "code"; channel: Channel; destination: string; challenge_id: string; fake_code?: string; resent: boolean };
type Step = { kind: "choose" } | { kind: "destination"; channel: Channel } | CodeStep | { kind: "google" };

const CHOOSER_KEY: Record<SignInVariant, string> = { choose_method: "auth.choose_method", welcome_back: "auth.welcome_back" };
const FIELD_KEY: Record<Channel, string> = { sms: "auth.sms.field", email: "auth.email.field" };

function errorCopy(e: unknown, fallback = "error.generic"): string {
  return e instanceof ApiRequestError ? copy(e.body.copy_key) : copy(fallback);
}

/** Google's standard sign-in button (brand guidelines: the "G" mark, Roboto 14/500, no custom styling beyond the theme variant). */
export function GoogleButton({ label, onClick, type = "button", disabled }: { label: string; onClick?: () => void; type?: "button" | "submit"; disabled?: boolean }) {
  return (
    <button type={type} className="sm-google-btn" onClick={onClick} disabled={disabled} data-method="google">
      <span className="sm-google-logo" aria-hidden="true">
        <svg viewBox="0 0 48 48" width="20" height="20" focusable="false">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
        </svg>
      </span>
      <span>{label}</span>
    </button>
  );
}

export function SignIn({ variant, deepLinkToken, onSession, onCancel, navigate, redirectUri }: SignInProps) {
  const id = useId();
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [destination, setDestination] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [passkeyFirst, setPasskeyFirst] = useState(false);
  const [fake, setFake] = useState({ email: "", email_verified: true, name: "" });
  useEffect(() => setPasskeyFirst(hasPasskeyOnDevice()), []); // after hydration: the hint lives in this browser only

  const chooserKey = CHOOSER_KEY[variant];
  const heading = copy(chooserKey);
  const [smsLabel = "", emailLabel = "", googleLabel = "", passkeyLabel = ""] = copyOptions(chooserKey);
  const [continueLabel = "", resendLabel = ""] = copyOptions("auth.code.enter");
  const go = navigate ?? ((url: string) => window.location.assign(url));

  const requestCode = async (channel: Channel, dest: string, resent: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.authOtpRequest(channel, dest);
      setCode("");
      setStep({ kind: "code", channel, destination: dest, challenge_id: r.challenge_id, fake_code: r.fake_code, resent });
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (s: CodeStep) => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.authOtpVerify(s.challenge_id, code.trim());
      onSession({ level: r.level, session: r.session, ...(r.expires_at ? { expires_at: r.expires_at } : {}) });
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setBusy(false);
    }
  };

  const passkey = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onSession(await passkeyAssert());
    } catch (e) {
      setError(errorCopy(e, "auth.passkey_failed")); // "That passkey didn't work. Use a code instead."
    } finally {
      setBusy(false);
    }
  };

  const google = async (hint?: FakeGoogleIdentity) => {
    setBusy(true);
    setError(undefined);
    try {
      if (deepLinkToken) setPendingDeepLink(deepLinkToken); // S5: the token is retained across Google's round trip
      const uri = redirectUri ?? `${window.location.origin}/app/auth/google/callback`;
      const r = await api.authOidcStart("google", uri, hint);
      go(r.authorization_url);
    } catch (e) {
      setError(errorCopy(e, "auth.google.failed"));
      setBusy(false);
    }
  };

  const submitDestination = (e: FormEvent, channel: Channel) => {
    e.preventDefault();
    const d = destination.trim();
    if (d) void requestCode(channel, d, false);
  };
  const submitFakeGoogle = (e: FormEvent) => {
    e.preventDefault();
    const email = fake.email.trim();
    if (!email) return;
    void google({ email, email_verified: fake.email_verified, ...(fake.name.trim() ? { name: fake.name.trim() } : {}) });
  };
  const back = () => {
    setError(undefined);
    setStep({ kind: "choose" });
  };

  return (
    <section className="sm-signin" id="otp" data-testid="sign-in" data-variant={variant} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} data-testid="sign-in-title">
        {heading}
      </h2>
      {step.kind === "choose" ? (
        <div className="sm-options" role="group" aria-label={heading} data-testid="sign-in-methods">
          {passkeyFirst ? (
            <button type="button" className="sm-btn sm-option sm-btn-primary" onClick={() => void passkey()} disabled={busy} data-method="passkey">
              <span>{passkeyLabel}</span>
            </button>
          ) : null}
          <button type="button" className={`sm-btn sm-option${passkeyFirst ? "" : " sm-btn-primary"}`} onClick={() => setStep({ kind: "destination", channel: "sms" })} disabled={busy} data-method="sms">
            <span>{smsLabel}</span>
          </button>
          <button type="button" className="sm-btn sm-option" onClick={() => setStep({ kind: "destination", channel: "email" })} disabled={busy} data-method="email">
            <span>{emailLabel}</span>
          </button>
          <GoogleButton label={googleLabel} onClick={() => (SHOW_FAKE_MARKERS ? setStep({ kind: "google" }) : void google())} disabled={busy} />
          {onCancel ? (
            <button type="button" className="sm-btn sm-btn-quiet" onClick={onCancel} disabled={busy}>
              Back
            </button>
          ) : null}
        </div>
      ) : null}

      {step.kind === "destination" ? (
        <form className="sm-signin-form" onSubmit={(e) => submitDestination(e, step.channel)} data-testid="sign-in-destination">
          <label className="sm-label" htmlFor={`${id}-dest`}>
            {copy(FIELD_KEY[step.channel])}
          </label>
          <input
            id={`${id}-dest`}
            className="sm-input"
            type={step.channel === "sms" ? "tel" : "email"}
            inputMode={step.channel === "sms" ? "tel" : "email"}
            autoComplete={step.channel === "sms" ? "tel" : "email"}
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            required
          />
          <p className="sm-source">{copyExtra(FIELD_KEY[step.channel], "helper")}</p>
          <div className="sm-card-actions">
            <button type="submit" className="sm-btn sm-btn-primary" disabled={busy || !destination.trim()}>
              {step.channel === "sms" ? smsLabel : emailLabel}
            </button>
            <button type="button" className="sm-btn sm-btn-quiet" onClick={back} disabled={busy}>
              Back
            </button>
          </div>
        </form>
      ) : null}

      {step.kind === "code" ? (
        <form
          className="sm-signin-form"
          onSubmit={(e) => {
            e.preventDefault();
            void verify(step);
          }}
          data-testid="sign-in-code"
        >
          {step.resent ? (
            <p className="sm-receipt" data-testid="code-resent">
              {copy("auth.code.resent", { destination: step.destination })}
            </p>
          ) : null}
          <label className="sm-label" htmlFor={`${id}-code`}>
            {copy("auth.code.enter", { destination: step.destination })}
          </label>
          <input id={`${id}-code`} className="sm-input sm-num" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
          {SHOW_FAKE_MARKERS && step.fake_code ? (
            // FAKE: FakeEdelivery echoes the code outside production so the screen can be walked without a phone
            <p>
              <span className="sm-fake" data-testid="fake-code" title="FAKE delivery: the code the API would have sent">
                FAKE code · {step.fake_code}
              </span>
            </p>
          ) : null}
          <div className="sm-card-actions">
            <button type="submit" className="sm-btn sm-btn-primary" disabled={busy || code.trim().length < 6}>
              {continueLabel}
            </button>
            <button type="button" className="sm-btn" onClick={() => void requestCode(step.channel, step.destination, true)} disabled={busy}>
              {resendLabel}
            </button>
            <button type="button" className="sm-btn sm-btn-quiet" onClick={back} disabled={busy}>
              Back
            </button>
          </div>
        </form>
      ) : null}

      {step.kind === "google" ? (
        // FAKE: FakeGoogleOidc — the consent screen is a test double; these values are the `fake` hint the start call carries (INTEGRATIONS=fake only)
        <form className="sm-signin-form sm-fake-form" onSubmit={submitFakeGoogle} data-testid="fake-google">
          <p style={{ margin: 0 }}>
            <span className="sm-fake" title="FakeGoogleOidc: no real Google consent screen in this environment">
              FAKE Google identity
            </span>
          </p>
          <label className="sm-label" htmlFor={`${id}-g-email`}>
            {copy("auth.email.field")}
          </label>
          <input id={`${id}-g-email`} className="sm-input" type="email" autoComplete="email" value={fake.email} onChange={(e) => setFake((f) => ({ ...f, email: e.target.value }))} required />
          <label className="sm-label" htmlFor={`${id}-g-name`}>
            Name (FAKE profile)
          </label>
          <input id={`${id}-g-name`} className="sm-input" value={fake.name} onChange={(e) => setFake((f) => ({ ...f, name: e.target.value }))} />
          <label className="sm-check">
            <input type="checkbox" checked={fake.email_verified} onChange={(e) => setFake((f) => ({ ...f, email_verified: e.target.checked }))} />
            <span>email_verified (FAKE claim)</span>
          </label>
          <div className="sm-card-actions">
            <GoogleButton label={googleLabel} type="submit" disabled={busy || !fake.email.trim()} />
            <button type="button" className="sm-btn sm-btn-quiet" onClick={back} disabled={busy}>
              Back
            </button>
          </div>
        </form>
      ) : null}

      {error ? (
        <p className="sm-error" role="alert" data-testid="sign-in-error">
          {error}
        </p>
      ) : null}
      <p className="sm-source" data-testid="identify-why">
        {copy("entry.identify.why")}
      </p>
    </section>
  );
}
