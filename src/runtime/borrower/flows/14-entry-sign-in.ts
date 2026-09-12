/**
 * 32.14 — Entry, sign-up and sign-in (spec/sections/32-borrower-experience/32-14-entry-sign-up-and-sign-in.md): the sign-in
 * side of the doors. The ways in (e-mail + password, Continue with Google, a code, a passkey) open the same session model in
 * src/runtime/borrower/routes.ts and oidc.ts; this flow owns what the thread says AFTER the session opened.
 *
 * Today that is nothing: the passkey offer line (`auth.passkey.offer`, docs/ux/15 S3) is retired by docs/ux/17 §0.4 —
 * passkeys stay in the code (the registration and assertion routes, `passkey_credentials`) and are not surfaced, so no
 * session ever posts the line (T12). The disclosure line stays 32.3's (E2, first in flow order).
 */
import type { BorrowerFlow } from "./index.ts";

export const FLOW_ID = "32.14";
/** The retired line's key — kept so tests can assert it never appears. */
export const PASSKEY_OFFER_COPY_KEY = "auth.passkey.offer";

export const FLOW_14_ENTRY_SIGN_IN: BorrowerFlow = {
  id: FLOW_ID,
  reacts: () => false,
  async onEvents() { /* the doors react to sessions, not to the owning processes' events */ },
  async onSessionOpened() { /* docs/ux/17 §0.4: no passkey offer; nothing else is said after the door */ },
};
