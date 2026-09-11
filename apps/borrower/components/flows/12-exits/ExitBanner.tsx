"use client";

import type { BorrowerRecord } from "@/lib/types/record";
import { copy } from "@/lib/copy";

/** The badges a loan leaves servicing under (32.12 §1.2 / §2): the Record is read-only under the last two. */
export const EXIT_BADGES = new Set(["Paying off", "Paid off", "Closed", "Servicing moving", "Transferred out"]);
export const READ_ONLY_EXIT_BADGES = new Set(["Closed", "Transferred out"]);

/**
 * 32.12 — the one line under a closed or transferred-out Record: the documents stay, the Thread stays open for questions
 * (`closed` / `transfer.after` / `transfer.after_window` — the server names the key and tokens, the library holds the sentence).
 */
export function ExitBanner({ r }: { r: BorrowerRecord }) {
  if (!r.read_only || !READ_ONLY_EXIT_BADGES.has(r.status.badge)) return null;
  const line = copy(r.status.one_liner, r.status.one_liner_tokens);
  return (
    <p className="sm-exit-banner sm-muted" data-testid="exit-banner" data-badge={r.status.badge} role="note">
      {line} {copy("exit.documents_stay")}
    </p>
  );
}
