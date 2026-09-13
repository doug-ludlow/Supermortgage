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

type Proposal = { proposed_at?: unknown; fields?: { path?: unknown; value?: unknown }[] };
const proposalOf = (c: AskCardLike): Proposal | null => { const p = c.props["proposal"]; return p && typeof p === "object" ? (p as Proposal) : null; };

/**
 * A proposal the borrower can confirm: every `required_paths` entry is in it, or already holds a value on the card. A proposal of
 * one field where two are required (the name without the e-mail) would rise with a Confirm that can only refuse (CARD_FIELD_REQUIRED);
 * the API refuses such a proposal (PROPOSAL_INCOMPLETE), and the screen keeps one off the stage if it ever arrives.
 */
export function proposalComplete(card: AskCardLike): boolean {
  const p = proposalOf(card); if (!p) return false;
  const required = Array.isArray(card.props["required_paths"]) ? (card.props["required_paths"] as unknown[]).map(String) : [];
  const fields = Array.isArray(card.props["fields"]) ? (card.props["fields"] as { path?: unknown; value?: unknown }[]) : [];
  const has = (path: string): boolean => (p.fields ?? []).some((f) => String(f.path) === path && String(f.value ?? "").trim() !== "") || fields.some((f) => String(f.path) === path && String(f.value ?? "").trim() !== "");
  return required.every(has);
}

/** Why the card rises, or null when it stays off the screen. */
export function riseReason(card: AskCardLike | null | undefined): RiseReason | null {
  if (!card) return null;
  if (proposalOf(card) && proposalComplete(card)) return "proposal";
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
/**
 * The one card for the stage: the newest proposal not set aside, else the card Michelle asked for, else the first of the record's needs
 * (its own order) that rises and is not set aside — "Not now" on one moves the stage to the next, never to nothing while another
 * tap is waiting. Null when nothing rises: the screen is the call.
 */
export function pickAsk<C extends AskCardLike & { status: string; created_at?: string }>(cards: Readonly<Record<string, C>>, needed: readonly string[], requestedId: string | undefined, dismissed: ReadonlySet<string>): C | null {
  const pending = Object.values(cards).filter((c) => c.status === "pending");
  const proposed = pending.filter((c) => !!proposalOf(c) && askRises(c, dismissed) === "proposal").sort((a, b) => (String(proposalOf(a)?.proposed_at ?? "") < String(proposalOf(b)?.proposed_at ?? "") ? 1 : -1))[0];
  if (proposed) return proposed;
  const requested = requestedId ? cards[requestedId] : undefined;
  if (requested && requested.status === "pending" && askRises(requested, dismissed)) return requested;
  for (const id of needed) { const c = cards[id]; if (c && c.status === "pending" && askRises(c, dismissed)) return c; }
  return null;
}
