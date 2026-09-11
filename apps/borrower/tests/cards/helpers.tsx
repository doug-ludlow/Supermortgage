import type { CardInstance, CardKind, CardPropsByKind, ResolveRequest } from "@/lib/types/cards";
import { vi } from "vitest";

export const TZ = "America/Phoenix";

/** Build a `card_instances` row for a kind (the shape every card renders from). */
export function makeCard<K extends CardKind>(kind: K, props: CardPropsByKind[K], overrides: Partial<CardInstance<K>> = {}): CardInstance<K> {
  return {
    card_instance_id: `card-${kind}-1`,
    conversation_id: "conv-1",
    party_id: "party-1",
    subject: { application_id: "app-1" },
    kind,
    status: "pending",
    created_by: "agent:intake",
    copy_key: "entry.goal.question",
    created_at: "2026-10-20T10:00:00-07:00",
    props,
    ...overrides,
  } as CardInstance<K>;
}

export function resolver() {
  const calls: ResolveRequest[] = [];
  const onResolve = vi.fn(async (req: ResolveRequest) => {
    calls.push(req);
  });
  return { onResolve, calls };
}
