"use client";

/**
 * 32.14 S3 "Mobile after Google" — `auth.add_mobile`, ConfirmCard-styled and non-blocking: the number is needed for SMS deep
 * links and fresh-L1 codes but never holds the flow up. `party.updateContact{phone}` then a code to that number
 * (auth/otp request → verify on the live session). Not now dismisses it; the dismissal is remembered for this browser session.
 *
 * FAKE: outside production the API echoes the code (`fake_code`) and it renders with the `.sm-fake` marker.
 */
import { useId, useState, type FormEvent } from "react";
import { api, ApiRequestError } from "@/lib/api/client";
import { copy, copyExtra, copyOptions } from "@/lib/copy";
import { SHOW_FAKE_MARKERS } from "@/lib/env";

export const ADD_MOBILE_DONE = "sm_add_mobile_done";
export const isAddMobileDone = (): boolean => {
  try {
    return window.sessionStorage.getItem(ADD_MOBILE_DONE) === "1";
  } catch {
    return false;
  }
};
const remember = () => {
  try {
    window.sessionStorage.setItem(ADD_MOBILE_DONE, "1");
  } catch {
    /* storage unavailable */
  }
};

type Step = { kind: "ask" } | { kind: "code"; challenge_id: string; destination: string; fake_code?: string };

export function AddMobilePrompt({ onDone }: { onDone: () => void }) {
  const id = useId();
  const [step, setStep] = useState<Step>({ kind: "ask" });
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [sendLabel = "", notNowLabel = ""] = copyOptions("auth.add_mobile");
  const [continueLabel = ""] = copyOptions("auth.code.enter");
  const fail = (e: unknown) => setError(e instanceof ApiRequestError ? copy(e.body.copy_key) : copy("error.generic"));
  const dismiss = () => {
    remember();
    onDone();
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const p = phone.trim();
    if (!p) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.command("party.updateContact", { phone: p });
      const r = await api.authOtpRequest("sms", p);
      setCode("");
      setStep({ kind: "code", challenge_id: r.challenge_id, destination: p, fake_code: r.fake_code });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: FormEvent, s: Extract<Step, { kind: "code" }>) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.authOtpVerify(s.challenge_id, code.trim());
      remember();
      onDone();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sm-card sm-add-mobile" data-testid="add-mobile" aria-labelledby={`${id}-title`}>
      <div className="sm-card-kind">
        <span>Please confirm</span>
      </div>
      <h3 id={`${id}-title`}>{copy("auth.add_mobile")}</h3>
      <p>{copyExtra("auth.add_mobile", "helper")}</p>
      {step.kind === "ask" ? (
        <form className="sm-signin-form" onSubmit={send}>
          <label className="sm-label" htmlFor={`${id}-phone`}>
            {copy("auth.sms.field")}
          </label>
          <input id={`${id}-phone`} className="sm-input" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          <div className="sm-card-actions">
            <button type="submit" className="sm-btn sm-btn-primary" disabled={busy || !phone.trim()}>
              {sendLabel}
            </button>
            <button type="button" className="sm-btn sm-btn-quiet" onClick={dismiss} disabled={busy}>
              {notNowLabel}
            </button>
          </div>
        </form>
      ) : (
        <form className="sm-signin-form" onSubmit={(e) => void verify(e, step)}>
          <label className="sm-label" htmlFor={`${id}-code`}>
            {copy("auth.code.enter", { destination: step.destination })}
          </label>
          <input id={`${id}-code`} className="sm-input sm-num" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
          {SHOW_FAKE_MARKERS && step.fake_code ? (
            <p>
              <span className="sm-fake" data-testid="fake-code">
                FAKE code · {step.fake_code}
              </span>
            </p>
          ) : null}
          <div className="sm-card-actions">
            <button type="submit" className="sm-btn sm-btn-primary" disabled={busy || code.trim().length < 6}>
              {continueLabel}
            </button>
            <button type="button" className="sm-btn sm-btn-quiet" onClick={dismiss} disabled={busy}>
              {notNowLabel}
            </button>
          </div>
        </form>
      )}
      {error ? (
        <p className="sm-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
