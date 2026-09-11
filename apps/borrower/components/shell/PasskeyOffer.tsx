"use client";

/**
 * 32.14 S3 — the inline action on the API's `{{copy:auth.passkey.offer}}` thread line (posted once, after the first session):
 * one tap registers a device passkey (register_options → the authenticator → register, lib/auth/passkey), skippable, no card.
 * The labels are the key's options; the dismissal is remembered for this browser session only.
 */
import { useEffect, useState } from "react";
import { copy, copyOptions } from "@/lib/copy";

export const PASSKEY_OFFER_DONE = "sm_passkey_offer_done";
const remember = () => {
  try {
    window.sessionStorage.setItem(PASSKEY_OFFER_DONE, "1");
  } catch {
    /* storage unavailable */
  }
};

export function PasskeyOffer({ onAdd }: { onAdd: () => Promise<void> }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "dismissed">("idle");
  const [error, setError] = useState<string | undefined>();
  const [addLabel = "", notNowLabel = ""] = copyOptions("auth.passkey.offer");
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(PASSKEY_OFFER_DONE) === "1") setState("dismissed");
    } catch {
      /* storage unavailable */
    }
  }, []);
  if (state === "dismissed") return null;
  if (state === "done")
    return (
      <div className="sm-receipt" data-testid="passkey-added">
        {addLabel}
      </div>
    );
  return (
    <div className="sm-offer-actions" data-testid="passkey-offer">
      <button
        type="button"
        className="sm-btn sm-btn-primary"
        disabled={state === "busy"}
        onClick={async () => {
          setState("busy");
          setError(undefined);
          try {
            await onAdd();
            remember();
            setState("done");
          } catch {
            setError(copy("auth.passkey_failed"));
            setState("idle");
          }
        }}
      >
        {addLabel}
      </button>
      <button
        type="button"
        className="sm-btn sm-btn-quiet"
        disabled={state === "busy"}
        onClick={() => {
          remember();
          setState("dismissed");
        }}
      >
        {notNowLabel}
      </button>
      {error ? (
        <p className="sm-error" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
