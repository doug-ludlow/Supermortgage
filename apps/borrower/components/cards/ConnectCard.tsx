"use client";

import { useState } from "react";
import { CardFrame, nowIso } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { ConnectCardEvidence, ConnectState, ConnectVendor } from "@/lib/types/cards";
import { copy, copyExtra } from "@/lib/copy";
import { SHOW_FAKE_MARKERS } from "@/lib/env";

export const VENDOR_LABEL: Record<ConnectVendor, string> = {
  stripe_identity: "Stripe Identity",
  plaid_assets: "Plaid",
  truv_income: "Truv",
  irs_ives: "IRS IVES",
  carrier_connect: "Carrier connection",
};

const STATE_LABEL: Record<ConnectState, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  connected: "Connected",
  failed: "Couldn't connect — we'll take documents instead",
  fallback_chosen: "Documents instead",
};

/**
 * 01 §3.4 — launch a vendor SDK and report its outcome. Resolves on the vendor webhook
 * (verification.received{kind} …), never on the SDK's client callback alone: the UI only
 * moves the card to in_progress and records the session; the API resolves it.
 *
 * FAKE: in fixtures/dev/nonprod every vendor here (Stripe Identity, Plaid, Truv, IRS IVES,
 * carrier connection) is a test double — the marker is rendered so nobody mistakes it for real.
 */
export function ConnectCard({ card, timezone, onResolve, onLaunchVendor, busy, error }: CardComponentProps<"ConnectCard">) {
  const { vendor, purpose_text, what_we_get, fallback, state, pre_intent_optional } = card.props;
  const [launching, setLaunching] = useState(false);
  const [localState, setLocalState] = useState<ConnectState>(state);
  const [launchError, setLaunchError] = useState<string | undefined>();
  const effective = card.status === "pending" ? localState : (card.evidence as ConnectCardEvidence | undefined)?.outcome ?? state;
  const label = VENDOR_LABEL[vendor];

  const launch = async () => {
    setLaunching(true);
    setLaunchError(undefined);
    try {
      const started_at = nowIso();
      const session = onLaunchVendor ? await onLaunchVendor(vendor, card.card_instance_id) : { vendor_session_id: `fake-${vendor}-${card.card_instance_id}` };
      setLocalState("in_progress");
      // The evidence below is provisional; the API overwrites `outcome`/`completed_at` from the webhook.
      const evidence: ConnectCardEvidence = { vendor, vendor_session_id: session.vendor_session_id, started_at, outcome: "in_progress" };
      await onResolve({ evidence, option_id: "connect" });
    } catch {
      // 01 §10 degraded vendor: failed + upload fallback; no error code is shown to the borrower (T-X-12).
      setLocalState("failed");
      setLaunchError("We'll take documents instead.");
    } finally {
      setLaunching(false);
    }
  };

  const chooseFallback = () => {
    const evidence: ConnectCardEvidence = { vendor, vendor_session_id: "", started_at: nowIso(), completed_at: nowIso(), outcome: "fallback_chosen" };
    void onResolve({ evidence, option_id: "fallback" });
  };

  return (
    <CardFrame card={card} timezone={timezone} title={purpose_text || copy(card.copy_key)} receipt={`${label} — ${STATE_LABEL[effective]}`} announce={STATE_LABEL[effective]} fakeVendor={SHOW_FAKE_MARKERS ? label : undefined}>
      <p>
        <strong>What we get:</strong> {what_we_get.length ? what_we_get.join(", ") : copyExtra(card.copy_key, "what_we_get")}
      </p>
      {pre_intent_optional ? <p>Optional now, saves paperwork later.</p> : null}
      <p className="sm-primary-text" data-testid="connect-state">
        Status: {STATE_LABEL[effective]}
      </p>
      {card.status === "pending" && (effective === "not_started" || effective === "failed") ? (
        <div className="sm-card-actions">
          <button type="button" className="sm-btn sm-btn-primary" onClick={launch} disabled={busy || launching}>
            {effective === "failed" ? `Try ${label} again` : `Connect with ${label}`}
          </button>
          <button type="button" className="sm-btn" onClick={chooseFallback} disabled={busy || launching}>
            {fallback.label}
          </button>
        </div>
      ) : null}
      {effective === "in_progress" ? <p>Waiting for {label} to finish — this card updates on its own.</p> : null}
      {launchError || error ? (
        <p className="sm-error" role="alert">
          {launchError ?? error}
        </p>
      ) : null}
    </CardFrame>
  );
}
