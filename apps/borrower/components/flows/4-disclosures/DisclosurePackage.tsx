"use client";

/**
 * 32.4 §2 — the Loan Estimate and its companion disclosures render as ONE grouped message ("Your Loan Estimate and
 * four related documents"), each document its own card: DocumentCards sharing `props.package_id` are pulled together
 * at the first one's position in the Thread; the LE leads, the companions follow. Cancelled companions never reach the
 * thread (the owning process never emits their delivery), so nothing here filters them.
 */
import type { ReactNode } from "react";
import type { AnyCardInstance } from "@/lib/types/cards";
import type { ThreadMessage } from "@/lib/types/record";
import { copy } from "@/lib/copy";

export type PackageRole = { role: "head"; package_id: string; cards: AnyCardInstance[] } | { role: "member"; package_id: string };

const packageOf = (c: AnyCardInstance | undefined): string | null => (c && c.kind === "DocumentCard" && typeof c.props.package_id === "string" && c.props.package_id ? c.props.package_id : null);

/** message_id → its role in a package: the first message of a package renders every member's card; the members render nothing of their own. */
export function packageMembers(sorted: readonly ThreadMessage[], cards: Record<string, AnyCardInstance>): Map<string, PackageRole> {
  const out = new Map<string, PackageRole>();
  const heads = new Map<string, { message_id: string; cards: AnyCardInstance[] }>();
  for (const m of sorted) {
    const card = m.card_instance_id ? cards[m.card_instance_id] : undefined;
    const pkg = packageOf(card);
    if (!pkg || !card) continue;
    const head = heads.get(pkg);
    if (!head) { heads.set(pkg, { message_id: m.message_id, cards: [card] }); continue; }
    head.cards.push(card);
    out.set(m.message_id, { role: "member", package_id: pkg });
  }
  for (const [package_id, h] of heads) {
    // the LE leads, whatever order the deliveries landed in; companions keep their delivery order
    const le = h.cards.filter((c) => c.kind === "DocumentCard" && c.props.disclosure_id === package_id && !c.props.electronic_copy);
    const rest = h.cards.filter((c) => !le.includes(c));
    if (h.cards.length > 1) out.set(h.message_id, { role: "head", package_id, cards: [...le, ...rest] });
  }
  return out;
}

export function DisclosurePackage({ packageId, cards, render }: { packageId: string; cards: AnyCardInstance[]; timezone: string; render: (card: AnyCardInstance) => ReactNode }) {
  const companions = cards.filter((c) => c.kind === "DocumentCard" && c.props.disclosure_id !== packageId).length;
  return (
    <section className="sm-package" data-testid="disclosure-package" data-package-id={packageId} aria-label={copy("le.package", { count: String(companions) })}>
      <p className="sm-primary-text" data-testid="disclosure-package-header" style={{ margin: "0 0 8px" }}>
        {copy("le.package", { count: String(companions) })}
      </p>
      <div className="sm-package-cards">{cards.map((c) => <div key={c.card_instance_id}>{render(c)}</div>)}</div>
    </section>
  );
}
