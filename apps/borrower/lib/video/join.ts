/**
 * 32.17 rule 15 — joining the vendor's room from the page itself. The live call is driven through the vendor's JavaScript client in
 * call-object mode (no prebuilt page, no vendor pre-join screen): the page joins the room with the borrower's first name as the
 * display name and renders the tracks in Supermortgage's own layout — the replica fills the call pane, the borrower is a
 * picture-in-picture tile. Pure: the options are computed here so the contract test can read them without a browser.
 */
export type JoinOptions = {
  readonly url: string;
  /** The display name the room sees — the borrower's first name when one is on file, else "You" (never an e-mail, never the platform's placeholder). */
  readonly userName: string;
  /** The page never lets the vendor's own pre-join UI stand in front of the call: the client joins directly. */
  readonly startVideoOff: boolean;
  readonly startAudioOff: boolean;
};

/** A name the platform made up is not a name to join with. */
export const displayNameOf = (firstName: string | null | undefined): string => {
  const first = (firstName ?? "").trim().split(/\s+/)[0] ?? "";
  return !first || first.includes("@") || /^borrower$/i.test(first) || /\d/.test(first) ? "You" : first;
};

export function joinOptionsFor(session: { conversation_url: string | null; borrower_camera?: "on" | "off" | undefined }, firstName: string | null | undefined): JoinOptions | null {
  if (!session.conversation_url || !/^https:\/\//.test(session.conversation_url)) return null;
  return { url: session.conversation_url, userName: displayNameOf(firstName), startVideoOff: session.borrower_camera === "off", startAudioOff: false };
}
