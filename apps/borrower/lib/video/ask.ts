/**
 * 32.17 rule 16 — when a card rises over the stage. The screen is the call; nothing else is on it until a tap is needed:
 *   proposal   Michelle proposed values into the card from what was said — Confirm (or Edit) is the borrower's to tap
 *   requested  Michelle asked for the card herself (card.request) — it is the thing she is talking about
 *   tap_only   a kind no words can answer (a consent, a connector, an upload, a schedule, a payment, a document, a hand-off, an
 *              invite, the demographics questions, an offer): the card is the answer, so it is on the screen while it is the ask
 * A ChoiceCard, ConfirmCard or ProfileCard with no proposal stays off the screen: Michelle asks in words and proposes what she hears.
 * "Not now" sets a card aside under its stamp — a new proposal or a new request changes the stamp and it rises again.
 */
export type AskCardLike = { readonly card_instance_id: string; readonly kind: string; readonly props: Record<string, unknown> };
export type RiseReason = "proposal" | "requested" | "tap_only";
/** The kinds Michelle can propose into from speech (the API's PROPOSABLE_KINDS, 32.16 §3.4); every other kind is answered on the card only. */
export const SPEAKABLE_KINDS: ReadonlySet<string> = new Set(["ChoiceCard", "ConfirmCard", "ProfileCard"]);

const proposalOf = (c: AskCardLike): { proposed_at?: unknown } | null => { const p = c.props["proposal"]; return p && typeof p === "object" ? (p as { proposed_at?: unknown }) : null; };

/** Why the card rises, or null when it stays off the screen. */
export function riseReason(card: AskCardLike | null | undefined): RiseReason | null {
  if (!card) return null;
  if (proposalOf(card)) return "proposal";
  if (card.props["requested_by"] === "card.request") return "requested";
  if (!SPEAKABLE_KINDS.has(card.kind)) return "tap_only";
  return null;
}
/** The stamp "Not now" sets aside: the card, its proposal's instant and whether Michelle requested it — a new proposal or request is a new stamp. */
export function askStamp(card: AskCardLike): string {
  return `${card.card_instance_id}:${String(proposalOf(card)?.proposed_at ?? "")}:${card.props["requested_by"] === "card.request" ? "req" : ""}`;
}
export function askRises(card: AskCardLike | null | undefined, dismissed: ReadonlySet<string>): RiseReason | null {
  const why = riseReason(card); if (!why || !card) return null;
  return dismissed.has(askStamp(card)) ? null : why;
}
