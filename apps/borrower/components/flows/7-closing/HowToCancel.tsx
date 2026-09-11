"use client";

/**
 * 32.7 §4 — the H-8/H-9 DocumentCard's "How to cancel" link (T8). A quiet link, never a primary button: tapping it posts
 * the borrower message the server named (`how_to_cancel.message_text`), and the flow answers in the thread with the
 * rescission ChoiceCard whose accent action is "Keep my loan". The link text is the copy library's (`rescission.how`).
 */
import type { HowToCancelLink } from "@/lib/types/cards";
import { copy } from "@/lib/copy";

export function HowToCancel({ link, onMessage, disabled }: { link: HowToCancelLink; onMessage?: (text: string) => Promise<void> | void; disabled?: boolean }) {
  return (
    <p className="sm-card-footer">
      <button type="button" className={`sm-link${link.quiet === false ? "" : " sm-quiet"}`} data-testid="how-to-cancel" disabled={disabled || !onMessage} onClick={() => void onMessage?.(link.message_text)}>
        {copy(link.copy_key)}
      </button>
    </p>
  );
}
