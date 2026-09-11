"use client";

import { CardFrame, nowIso } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { HandoffDestination } from "@/lib/types/cards";
import { SHOW_FAKE_MARKERS } from "@/lib/env";
import { handoffLine } from "@/components/flows/7-closing";

const DEST_LABEL: Record<HandoffDestination, string> = {
  ron_platform: "Online notary session",
  settlement_agent: "Your settlement agent",
  appraiser: "The appraiser",
  notary_wet: "In-person notary",
  prior_servicer: "Your previous servicer",
  fannie_mae_letter: "A letter in the mail",
  hoa_management: "Your HOA management company",
};

/**
 * 01 §3.14 — a step that happens outside the app. The RON platform is a vendor:
 * FAKE outside production, and marked as such.
 */
export function HandoffCard({ card, timezone, onResolve, onLaunchVendor, busy }: CardComponentProps<"HandoffCard">) {
  const p = card.props;
  const pending = card.status === "pending";
  const isVendor = p.destination === "ron_platform";
  const fake = SHOW_FAKE_MARKERS && isVendor ? "RON platform" : undefined;

  const launch = async () => {
    const started_at = nowIso();
    const session = onLaunchVendor ? await onLaunchVendor("ron_platform", card.card_instance_id) : { vendor_session_id: `fake-ron-${card.card_instance_id}` };
    await onResolve({ evidence: { destination: p.destination, vendor_session_id: session.vendor_session_id, started_at }, option_id: "launch" });
  };

  return (
    <CardFrame card={card} timezone={timezone} title={p.title ?? DEST_LABEL[p.destination]} collapsible={isVendor} receipt={`${DEST_LABEL[p.destination]} — started`} fakeVendor={fake}>
      <p className="sm-primary-text">{handoffLine(p.what_to_expect, p.what_to_expect_copy_key, p.copy_tokens)}</p>
      {p.explainer_headline || p.explainer_points?.length ? (
        <div className="sm-card-block" data-testid="handoff-explainer">
          {p.explainer_headline ? <p className="sm-primary-text">{p.explainer_headline}</p> : null}
          {p.explainer_points?.length ? (
            <ul>
              {p.explainer_points.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <p>When it's done, you'll see: {handoffLine(p.return_state, p.return_state_copy_key, p.copy_tokens)}</p>
      {pending && isVendor ? (
        <div className="sm-card-actions">
          {p.launch_url ? (
            <a className="sm-btn sm-btn-primary" href={p.launch_url} target="_blank" rel="noreferrer noopener" onClick={() => void launch()}>
              Open the signing session
            </a>
          ) : (
            <button type="button" className="sm-btn sm-btn-primary" onClick={() => void launch()} disabled={busy}>
              Open the signing session
            </button>
          )}
        </div>
      ) : null}
    </CardFrame>
  );
}
