"use client";

/**
 * 32.16 §2.0 (DELTA-29) — the account: the first screen, and the only form. One component, three modes:
 *  - `sign_up`  (/app/sign-up): the disclosure line (`entry.disclosure.first`), e-mail, password, Create account, Continue with
 *    Google, "Already have an account? Sign in". Create → the session at once for an e-mail on file for no one; when the e-mail
 *    is already on file for someone's record the code step first (`account.verify.title` + `account.on_file`, the field is
 *    `auth.code.enter` with the e-mail; the FAKE code shown outside production) → `verify_email` → the session.
 *  - `sign_in`  (/app/sign-in, the header's Sign in, any 401 under `auth.welcome_back`): e-mail, password, Sign in, Google,
 *    "Forgot your password?", "New here? Create an account". `EMAIL_UNVERIFIED` (a fresh code was sent) → the code step.
 *  - `reset`    (/app/reset): e-mail → `request_reset` → code + new password → `reset` → `account.reset.done` + Sign in.
 * Passkeys are not offered anywhere (docs/ux/17 §0.4); codes are kept for e-mail verification, reset and the fresh-L1 step-up.
 * On a session the caller decides what happens next (`onSession`); by default the app lands on /app. The proxy has already
 * turned `token` into the HttpOnly cookie. Every string is a copy key.
 *
 * Google is unchanged from docs/ux/15 DELTA-12: `POST /v1/borrower/auth/oidc start` → the app navigates to `authorization_url`;
 * Google returns to /app/auth/google/callback. FAKE: outside production a small FAKE identity form stands in for Google's consent
 * screen (its values become the `fake` hint; the API refuses the hint outside INTEGRATIONS=fake), and the API echoes the one-time
 * code (`fake_code`, FakeEdelivery) — both render with the `.sm-fake` marker.
 *
 * `id="otp"` on the root: 32.13-T11 waits for that selector on /app/d/{token} without a session (the one-time-code screen).
 */
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { api, ApiRequestError } from "@/lib/api/client";
import { accountCreate, accountRequestReset, accountReset, accountSignIn, accountVerifyEmail, challengeOf, isChallenge, type AccountSession } from "@/lib/api/account";
import { copy, copyExtra, copyOptions } from "@/lib/copy";
import { PARTNER_LEGAL_NAME, SHOW_FAKE_MARKERS } from "@/lib/env";
import { setPendingDeepLink } from "@/lib/auth/passkey";
import { GoogleButton } from "./GoogleButton";

export type AccountMode = "sign_up" | "sign_in" | "reset";
/** The FAKE identity hint FakeGoogleOidc turns into a verified (or not) Google identity. */
export type FakeGoogleIdentity = { email: string; email_verified?: boolean; name?: string; sub?: string };

export type AccountProps = {
  mode: AccountMode;
  /** The heading over the sign-in form (`auth.welcome_back` on a 401 over the shell; default `account.signin.title`). */
  titleKey?: string;
  /** Called with the session body; without it the app lands on /app. */
  onSession?: (session: AccountSession) => void;
  /** Shown as a quiet Back (the header's Sign in over a live thread). */
  onCancel?: () => void;
  /** Navigation (the Google redirect, the /app landing) — window.location.assign unless a test injects one. */
  navigate?: (url: string) => void;
  /** Google's redirect target; defaults to this origin's /app/auth/google/callback. */
  redirectUri?: string;
  /** A deep-link token to resume after the session (kept in sessionStorage across the Google round trip). */
  deepLinkToken?: string;
  /** The partner named in the disclosure line; defaults to the build's `NEXT_PUBLIC_PARTNER_LEGAL_NAME`. */
  partnerLegalName?: string;
};

type CodeStep = { kind: "code"; email: string; challenge_id: string; fake_code?: string; on_file?: boolean };
type ResetCodeStep = { kind: "reset_code"; email: string; challenge_id?: string; fake_code?: string };
type Step = { kind: "form" } | CodeStep | ResetCodeStep | { kind: "done" } | { kind: "google" };

const PASSWORD_MIN = 8;

function errorCopy(e: unknown, fallback = "error.generic"): string {
  return e instanceof ApiRequestError ? copy(e.body.copy_key) : copy(fallback);
}

export function Account({ mode, titleKey, onSession, onCancel, navigate, redirectUri, deepLinkToken, partnerLegalName }: AccountProps) {
  const id = useId();
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [fake, setFake] = useState({ email: "", email_verified: true, name: "" });

  const go = navigate ?? ((url: string) => window.location.assign(url));
  const settle = (s: AccountSession) => (onSession ? onSession(s) : go("/app"));
  const partner = partnerLegalName ?? PARTNER_LEGAL_NAME;
  const [continueLabel = ""] = copyOptions("auth.code.enter");
  const googleLabel = copy("auth.google.button");

  const heading =
    step.kind === "code" ? copy("account.verify.title")
    : step.kind === "reset_code" ? copy("account.reset.code")
    : mode === "sign_up" ? copy("account.create.title")
    : mode === "reset" ? copy("account.reset.title")
    : copy(titleKey ?? "account.signin.title");

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await f();
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setBusy(false);
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    const em = email.trim();
    if (!em || password.length < PASSWORD_MIN) return;
    void run(async () => {
      const r = await accountCreate(em, password);
      if (!isChallenge(r)) { settle(r); return; }   // an e-mail on file for no one: the session at once, no code
      setCode("");
      setStep({ kind: "code", email: em, challenge_id: r.challenge_id, fake_code: r.fake_code, on_file: true });   // on file for someone's record: prove the e-mail first
    });
  };

  const signIn = (e: FormEvent) => {
    e.preventDefault();
    const em = email.trim();
    if (!em || !password) return;
    setBusy(true);
    setError(undefined);
    accountSignIn(em, password)
      .then((s) => settle(s))
      .catch((err: unknown) => {
        // EMAIL_UNVERIFIED: a fresh code was just sent — the refusal's line stays on screen over the code step
        const ch = err instanceof ApiRequestError && err.status === 403 ? challengeOf(err) : undefined;
        if (ch) {
          setCode("");
          setStep({ kind: "code", email: em, ...ch });
        }
        setError(errorCopy(err));
      })
      .finally(() => setBusy(false));
  };

  const verify = (e: FormEvent, s: CodeStep) => {
    e.preventDefault();
    void run(async () => settle(await accountVerifyEmail(s.challenge_id, code.trim())));
  };

  const requestReset = (e: FormEvent) => {
    e.preventDefault();
    const em = email.trim();
    if (!em) return;
    void run(async () => {
      const r = await accountRequestReset(em);
      setCode("");
      setPassword("");
      setStep({ kind: "reset_code", email: em, challenge_id: r.challenge_id, fake_code: r.fake_code });
    });
  };

  const reset = (e: FormEvent, s: ResetCodeStep) => {
    e.preventDefault();
    if (password.length < PASSWORD_MIN) return;
    void run(async () => {
      await accountReset(s.challenge_id ?? "", code.trim(), password);
      setPassword("");
      setStep({ kind: "done" });
    });
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
  const submitFakeGoogle = (e: FormEvent) => {
    e.preventDefault();
    const em = fake.email.trim();
    if (!em) return;
    void google({ email: em, email_verified: fake.email_verified, ...(fake.name.trim() ? { name: fake.name.trim() } : {}) });
  };
  const back = () => {
    setError(undefined);
    setStep({ kind: "form" });
  };

  const emailField = (
    <>
      <label className="sm-label" htmlFor={`${id}-email`}>
        {copy("account.email.field")}
      </label>
      <input id={`${id}-email`} className="sm-input" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
    </>
  );
  const passwordField = (auto: "current-password" | "new-password") => (
    <>
      <label className="sm-label" htmlFor={`${id}-password`}>
        {copy("account.password.field")}
      </label>
      <input id={`${id}-password`} className="sm-input" type="password" autoComplete={auto} minLength={auto === "new-password" ? PASSWORD_MIN : undefined} value={password} onChange={(e) => setPassword(e.target.value)} required />
      {auto === "new-password" ? <p className="sm-source">{copyExtra("account.password.field", "helper")}</p> : null}
    </>
  );
  const googleBlock = (
    <div className="sm-options" data-testid="account-google">
      <GoogleButton label={googleLabel} onClick={() => (SHOW_FAKE_MARKERS ? setStep({ kind: "google" }) : void google())} disabled={busy} />
    </div>
  );
  const cancel = onCancel ? (
    <button type="button" className="sm-btn sm-btn-quiet" onClick={onCancel} disabled={busy}>
      Back
    </button>
  ) : null;

  return (
    <section className="sm-signin" id="otp" data-testid="account" data-mode={mode} data-step={step.kind} aria-labelledby={`${id}-title`}>
      {mode === "sign_up" && step.kind === "form" ? (
        // 32.16 §2.0: the automation disclosure is the first assistant line on the account screen (and again as the first message of every session)
        <p className="sm-source" data-testid="account-disclosure" data-copy-key="entry.disclosure.first" data-automated="true">
          {copy("entry.disclosure.first", { "partner.legal_name": partner })}
        </p>
      ) : null}
      <h2 id={`${id}-title`} data-testid="account-title">
        {heading}
      </h2>

      {step.kind === "form" && mode === "sign_up" ? (
        <>
          <form className="sm-signin-form" onSubmit={create} data-testid="account-form">
            {emailField}
            {passwordField("new-password")}
            <div className="sm-card-actions">
              <button type="submit" className="sm-btn sm-btn-primary" disabled={busy || !email.trim() || password.length < PASSWORD_MIN}>
                {copy("account.create.button")}
              </button>
              {cancel}
            </div>
          </form>
          {googleBlock}
          <p>
            <Link className="sm-account-link" href="/sign-in" data-testid="account-switch">
              {copy("account.have_account")}
            </Link>
          </p>
        </>
      ) : null}

      {step.kind === "form" && mode === "sign_in" ? (
        <>
          <form className="sm-signin-form" onSubmit={signIn} data-testid="account-form">
            {emailField}
            {passwordField("current-password")}
            <div className="sm-card-actions">
              <button type="submit" className="sm-btn sm-btn-primary" disabled={busy || !email.trim() || !password}>
                {copy("account.signin.button")}
              </button>
              {cancel}
            </div>
          </form>
          {googleBlock}
          <p>
            <Link className="sm-account-link" href="/reset" data-testid="account-forgot">
              {copy("account.forgot")}
            </Link>
          </p>
          <p>
            <Link className="sm-account-link" href="/sign-up" data-testid="account-switch">
              {copy("account.new")}
            </Link>
          </p>
        </>
      ) : null}

      {step.kind === "form" && mode === "reset" ? (
        <form className="sm-signin-form" onSubmit={requestReset} data-testid="account-form">
          {emailField}
          <div className="sm-card-actions">
            <button type="submit" className="sm-btn sm-btn-primary" disabled={busy || !email.trim()}>
              {continueLabel}
            </button>
            {cancel}
          </div>
        </form>
      ) : null}

      {step.kind === "code" ? (
        <form className="sm-signin-form" onSubmit={(e) => verify(e, step)} data-testid="account-code">
          {step.on_file ? (
            <p className="sm-muted" data-testid="account-on-file" data-copy-key="account.on_file">
              {copy("account.on_file")}
            </p>
          ) : null}
          <label className="sm-label" htmlFor={`${id}-code`}>
            {copy("auth.code.enter", { destination: step.email })}
          </label>
          <input id={`${id}-code`} className="sm-input sm-num" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
          {SHOW_FAKE_MARKERS && step.fake_code ? (
            // FAKE: FakeEdelivery echoes the code outside production so the screen can be walked without a mailbox
            <p>
              <span className="sm-fake" data-testid="fake-code" title="FAKE delivery: the code the API would have e-mailed">
                FAKE code · {step.fake_code}
              </span>
            </p>
          ) : null}
          <div className="sm-card-actions">
            <button type="submit" className="sm-btn sm-btn-primary" disabled={busy || code.trim().length < 6}>
              {continueLabel}
            </button>
            <button type="button" className="sm-btn sm-btn-quiet" onClick={back} disabled={busy}>
              Back
            </button>
          </div>
        </form>
      ) : null}

      {step.kind === "reset_code" ? (
        <form className="sm-signin-form" onSubmit={(e) => reset(e, step)} data-testid="account-reset">
          <label className="sm-label" htmlFor={`${id}-code`}>
            {copy("auth.code.enter", { destination: step.email })}
          </label>
          <input id={`${id}-code`} className="sm-input sm-num" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
          {SHOW_FAKE_MARKERS && step.fake_code ? (
            <p>
              <span className="sm-fake" data-testid="fake-code" title="FAKE delivery: the code the API would have e-mailed">
                FAKE code · {step.fake_code}
              </span>
            </p>
          ) : null}
          {passwordField("new-password")}
          <div className="sm-card-actions">
            <button type="submit" className="sm-btn sm-btn-primary" disabled={busy || code.trim().length < 6 || password.length < PASSWORD_MIN}>
              {copy("account.reset.button")}
            </button>
            <button type="button" className="sm-btn sm-btn-quiet" onClick={back} disabled={busy}>
              Back
            </button>
          </div>
        </form>
      ) : null}

      {step.kind === "done" ? (
        <div className="sm-signin-form" data-testid="account-done">
          <p className="sm-receipt">{copy("account.reset.done")}</p>
          <p>
            <Link className="sm-btn sm-btn-primary" href="/sign-in">
              {copy("account.signin.button")}
            </Link>
          </p>
        </div>
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
        <p className="sm-error" role="alert" data-testid="account-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
