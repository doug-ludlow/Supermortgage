"use client";
/**
 * The partner door (36.1 rule 1 — 34.1's mechanics): a six-digit code to the e-mail (the FAKE port echoes `fake_code`
 * outside production, shown here as the borrower and staff doors show it), verified into an enrol/step token; at enrolment the
 * password is set on that token; then the password opens the session (the proxy keeps the token in the cookie). A password
 * alone opens nothing; a code alone opens nothing.
 */
import { useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { api, ApiRequestError, returnPathOf } from "@/lib/api/client";

type Step = "email" | "code" | "set-password" | "password";
const MIN_PASSWORD = 12;

export function Door({ partnerLegalName, partnerNmlsrId }: { partnerLegalName: string | null; partnerNmlsrId: string | null }) {
  const search = useSearchParams();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [fakeCode, setFakeCode] = useState<string | null>(null);
  const [stepToken, setStepToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const returnTo = returnPathOf(search.toString() ? `?${search.toString()}` : "");

  const fail = (e: unknown): void => {
    if (e instanceof ApiRequestError) {
      const c = e.body.code;
      setError(c === "SIGNIN_INVALID" || c === "OTP_INVALID" ? "The e-mail, the code or the password is not valid." : c === "PASSWORD_WEAK" ? `The password needs at least ${MIN_PASSWORD} characters and must not appear on the breached-password list.` : c === "FACTOR_REQUIRED" ? "Request a new code: a session opens only after the code and the password." : c === "OTP_TOO_MANY_ATTEMPTS" ? "Too many attempts. Request a new code." : `${c}${e.body.reason ? ` — ${e.body.reason}` : ""}`);
    } else setError(e instanceof Error ? e.message : String(e));
  };
  const run = async (fn: () => Promise<void>): Promise<void> => { setBusy(true); setError(null); try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); } };

  const sendCode = (ev: FormEvent): void => { ev.preventDefault(); void run(async () => { const r = await api.authCode(email.trim()); setFakeCode(r.fake_code ?? null); setCode(""); setStep("code"); }); };
  const verify = (ev: FormEvent): void => { ev.preventDefault(); void run(async () => { const v = await api.authVerify(email.trim(), code.trim()); setStepToken(v.token); setPassword(""); setStep(v.has_password && v.status === "active" ? "password" : "set-password"); }); };
  const setAndSignIn = (ev: FormEvent): void => { ev.preventDefault(); void run(async () => { await api.authPassword(stepToken ?? "", password); await api.authSignIn(email.trim(), password); window.location.assign(returnTo); }); };
  const signIn = (ev: FormEvent): void => { ev.preventDefault(); void run(async () => { await api.authSignIn(email.trim(), password); window.location.assign(returnTo); }); };

  return (
    <div className="door" data-testid="door" data-step={step}>
      <div className="card">
        <h1>Sign in</h1>
        <p className="partner" data-testid="door-partner">{partnerLegalName ?? "Servicing partner portal"}{partnerNmlsrId ? ` · NMLSR ID ${partnerNmlsrId}` : ""}</p>
        {error ? <div className="error" role="alert" data-testid="door-error">{error}</div> : null}
        {step === "email" ? (
          <form className="form" onSubmit={sendCode}>
            <label>Work e-mail<input type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} data-testid="door-email" /></label>
            <p className="note">A six-digit code goes to this address. The password comes after the code.</p>
            <button className="btn" type="submit" disabled={busy} data-testid="door-send-code">Send code</button>
          </form>
        ) : null}
        {step === "code" ? (
          <form className="form" onSubmit={verify}>
            <p className="note">Code sent to <strong>{email}</strong>. It is good for 10 minutes.</p>
            {fakeCode ? <p className="fake" data-testid="door-fake-code">FAKE delivery — the code is <code>{fakeCode}</code></p> : null}
            <label>Code<input inputMode="numeric" pattern="[0-9]{6}" name="code" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} data-testid="door-code" /></label>
            <div className="row">
              <button className="btn" type="submit" disabled={busy} data-testid="door-verify">Verify code</button>
              <button className="btn secondary" type="button" disabled={busy} onClick={() => setStep("email")}>Use another e-mail</button>
            </div>
          </form>
        ) : null}
        {step === "set-password" ? (
          <form className="form" onSubmit={setAndSignIn}>
            <p className="note">First sign-in: set the password for this account (at least {MIN_PASSWORD} characters).</p>
            <label>New password<input type="password" name="new-password" autoComplete="new-password" minLength={MIN_PASSWORD} required value={password} onChange={(e) => setPassword(e.target.value)} data-testid="door-new-password" /></label>
            <button className="btn" type="submit" disabled={busy} data-testid="door-set-password">Set password and sign in</button>
          </form>
        ) : null}
        {step === "password" ? (
          <form className="form" onSubmit={signIn}>
            <label>Password<input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} data-testid="door-password" /></label>
            <button className="btn" type="submit" disabled={busy} data-testid="door-sign-in">Sign in</button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
