/**
 * 32.14 — Entry, sign-up and sign-in (spec/sections/32-borrower-experience/32-14-entry-sign-up-and-sign-in.md): the sign-in
 * side of the doors. The three ways in (a code, Continue with Google, a passkey) open the same session model in
 * src/runtime/borrower/routes.ts and oidc.ts; this flow owns what the thread says AFTER the session opened:
 *
 *   session opened (first session of a party)   the passkey offer — one agent line `{{copy:auth.passkey.offer}}` (S3: "a device
 *                                                credential, one tap, skippable" — no card, no command; the shell's inline action runs the
 *                                                existing passkey registration path). Once per party, never on a voice session, never
 *                                                for a party that already holds a passkey. (T12)
 *
 * The disclosure line stays 32.3's (E2, first in flow order); this flow runs last so the offer follows the session's disclosure and
 * whatever 32.3 posted. The anonymous minute (S0–S2) and the lead→party link are Phase 2's (flows/14-entry-lead.ts).
 */
import type { BorrowerFlow, FlowDeps, SessionOpened } from "./index.ts";

export const FLOW_ID = "32.14";
export const PASSKEY_OFFER_COPY_KEY = "auth.passkey.offer";
const offerLine = `{{copy:${PASSKEY_OFFER_COPY_KEY}}}`;

/** The party's first session ever: no other sessions row exists for it (the one the hook runs for was just created). */
async function isFirstSession(deps: FlowDeps, s: SessionOpened): Promise<boolean> {
  const r = (await deps.runtime.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM sessions WHERE party_id = $1 AND session_id <> $2`, [s.party_id, s.session_id]))[0];
  return Number(r?.n ?? 0) === 0;
}
async function passkeyOffer(deps: FlowDeps, s: SessionOpened): Promise<void> {
  if (s.channel === "voice" || s.auth_method === "passkey") return;   // a passkey is an app affordance; a passkey session already has one
  if (!(await isFirstSession(deps, s))) return;
  const held = (await deps.runtime.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM passkey_credentials WHERE party_id = $1 AND revoked_at IS NULL`, [s.party_id]))[0];
  if (Number(held?.n ?? 0) > 0) return;
  const conv = await deps.ui.conversationFor(s.party_id);
  const already = await deps.runtime.db.query<{ message_id: string }>(`SELECT message_id FROM messages WHERE conversation_id = $1 AND body_text = $2 LIMIT 1`, [conv.conversation_id, offerLine]);
  if (already.length) return;   // renders once (T12), whatever re-runs the hook
  await deps.ui.appendMessage({ conversation_id: conv.conversation_id, at: s.at, sender: "agent", sender_ref: "agent:intake", channel: "app", body_text: offerLine });
  deps.logger?.info("borrower.flow.32-14.passkey_offer", { party_id: s.party_id, session_id: s.session_id, auth_method: s.auth_method });
}

export const FLOW_14_ENTRY_SIGN_IN: BorrowerFlow = {
  id: FLOW_ID,
  reacts: () => false,
  async onEvents() { /* the doors react to sessions, not to the owning processes' events */ },
  onSessionOpened: passkeyOffer,
};
