"use client";

/**
 * 32.16 §2.1 — the two things a card can be in the thread, neither of them a card component:
 *
 *  - a **reference chip**: the one-line reference the assistant attaches when it puts something on the rail
 *    ("Connect your payroll →"); tapping it focuses and expands that `card_instance_id` on the rail (below 768 px the rail is
 *    the bottom sheet and the chip opens it). Once the card is resolved the chip shows the card's receipt line (T12).
 *  - a **confirm chip**: a pending card whose `props.proposal` the model wrote (`card.propose`, §3.4) — the read-back
 *    ("$8,200.00 / month base pay · Acme Corp") with Confirm · Edit. Confirm resolves the same `card_instances` row through
 *    `resolveCard` (`evidence.source = borrower_stated`); Edit expands the card on the rail. The only actionable element in
 *    the thread — and it is a card.
 *
 * Money in a proposal is a string of cents (the model transcribes, never calculates); the chip formats it with lib/format,
 * never arithmetic. Enum ids read back as the card's own option labels.
 */
import type { AnyCardInstance, CardProposal, ChoiceCardEvidence, ConfirmCardEvidence, ConnectCardProps, ResolveRequest } from "@/lib/types/cards";
import { copy, copyOrUndefined } from "@/lib/copy";
import { formatDate, formatMoney } from "@/lib/format";
import { nowIso } from "@/components/cards/CardFrame";

const CONNECT_LABEL: Record<ConnectCardProps["vendor"], string> = { stripe_identity: "Stripe Identity", plaid_assets: "Plaid", truv_income: "Truv", irs_ives: "IRS", carrier_connect: "your insurer" };
const CONNECT_STATE_KEY: Record<ConnectCardProps["state"], string> = { not_started: "connection.not_connected", in_progress: "connection.in_progress", connected: "connection.connected", failed: "connection.failed", fallback_chosen: "connection.fallback" };

/** The card's one-line title, the way the rail and the chips name it: its own title, else the copy library's sentence for its key. */
export function cardTitle(c: AnyCardInstance): string {
  const p = c.props as Record<string, unknown>;
  const tokens = (p.copy_tokens as Record<string, string> | undefined) ?? {};
  if (c.kind === "ConnectCard") return (p.purpose_text as string) || copyOrUndefined(c.copy_key, tokens) || `Connect ${CONNECT_LABEL[(p.vendor as ConnectCardProps["vendor"]) ?? "truv_income"]}`;
  if (c.kind === "PersonCard") return (p.name as string) || copyOrUndefined(p.name_copy_key as string | undefined) || copy(c.copy_key, tokens);
  return (p.title as string) || (p.state_label as string) || (p.subject as string) || copyOrUndefined(p.label_copy_key as string | undefined, tokens) || copy(c.copy_key, tokens);
}

/** A ConnectCard's state as the Connections rows and receipts read it. */
export function connectionState(c: AnyCardInstance): string {
  const p = c.props as Partial<ConnectCardProps>;
  const state = c.status === "resolved" && p.state !== "failed" && p.state !== "fallback_chosen" ? "connected" : (p.state ?? "not_started");
  return copy(CONNECT_STATE_KEY[state] ?? "connection.not_connected");
}

/** The resolved card's receipt line (01 §1.3: resolved cards collapse to one line), per kind — the same line CardFrame shows. */
export function receiptOf(c: AnyCardInstance, timezone: string): string {
  const title = cardTitle(c);
  const p = c.props as Record<string, unknown>;
  const when = c.resolved_at ? formatDate(c.resolved_at, timezone, "datetime") : "";
  switch (c.kind) {
    case "ChoiceCard": {
      const id = (c.evidence as ChoiceCardEvidence | undefined)?.option_id;
      const label = (p.options as { id: string; label: string }[] | undefined)?.find((o) => o.id === id)?.label;
      return label ? `${title} — ${label}` : `${title} — ${c.status}`;
    }
    case "ConfirmCard":
    case "ProfileCard":
    case "DemographicsCard":
      return `${title} — confirmed`;
    case "DocumentCard": {
      const at = (c.evidence as { received_at?: string } | undefined)?.received_at ?? (p.received_at as string | undefined);
      return `${title} received ${at ? formatDate(at, timezone, "datetime") : when}`.trim();
    }
    case "ConnectCard":
      return `${CONNECT_LABEL[(p.vendor as ConnectCardProps["vendor"]) ?? "truv_income"]} — ${connectionState(c)}`;
    case "ConsentCard":
      return `${title} — agreed${when ? ` ${when}` : ""}`;
    default:
      return `${title} — ${c.status}${when ? ` ${when}` : ""}`;
  }
}

/** The read-back of a proposal: money paths in cents → dollars, enum ids → the card's option labels, joined with " · ". */
export function proposalReadback(c: AnyCardInstance, proposal: CardProposal): string {
  const p = c.props as Record<string, unknown>;
  const parts: string[] = [];
  if (proposal.option_id) {
    const options = (p.options as { id: string; label: string }[] | undefined) ?? [];
    parts.push(options.find((o) => o.id === proposal.option_id)?.label ?? proposal.option_id);
  }
  for (const f of proposal.fields ?? []) {
    const fields = (p.fields as { path: string; label?: string; options?: { id: string; label: string }[] }[] | undefined) ?? [];
    const def = fields.find((x) => x.path === f.path);
    const money = /(_cents$|income|amount|balance|payment|value|price)/i.test(f.path) && /^-?\d+$/.test(f.value);
    const enumLabel = def?.options?.find((o) => o.id === f.value)?.label;
    const value = enumLabel ?? (money ? formatMoney(f.value) : f.value);
    parts.push(def?.label ? `${value} ${def.label}` : value);
  }
  return parts.join(" · ");
}

/** Confirm → the ResolveRequest for the card's kind (§3.4): `{ option_id }` for a ChoiceCard, the confirmed fields with `source: borrower_stated` otherwise. */
export function proposalResolveRequest(c: AnyCardInstance, proposal: CardProposal): ResolveRequest {
  const at = nowIso();
  if (c.kind === "ChoiceCard" && proposal.option_id) {
    const evidence: ChoiceCardEvidence = { option_id: proposal.option_id, tapped_at: at, disclosure_version_shown: (c.props as { disclosure_version_shown?: string }).disclosure_version_shown };
    return { option_id: proposal.option_id, evidence };
  }
  const fields = (proposal.fields ?? []).map((f) => ({ path: f.path, value_confirmed: f.value, source: "borrower" as const, confirmed_at: at }));
  const evidence: ConfirmCardEvidence & { source: "borrower_stated" } = { fields, edited: false, source: "borrower_stated" };
  return { evidence, ...(proposal.option_id ? { option_id: proposal.option_id } : {}) };
}

export function ReferenceChip({ card, timezone, onOpen }: { card: AnyCardInstance; timezone: string; onOpen: (card_instance_id: string) => void }) {
  const resolved = card.status !== "pending";
  return (
    <button type="button" className={`sm-chip${resolved ? " sm-chip-receipt" : ""}`} data-testid={resolved ? "chip-receipt" : "reference-chip"} data-card-id={card.card_instance_id} data-card-kind={card.kind} onClick={() => onOpen(card.card_instance_id)}>
      {resolved ? receiptOf(card, timezone) : copy("chip.reference", { label: cardTitle(card) })}
    </button>
  );
}

export function ConfirmChip({ card, proposal, busy, error, onConfirm, onEdit }: { card: AnyCardInstance; proposal: CardProposal; busy?: boolean; error?: string; onConfirm: (req: ResolveRequest) => void; onEdit: (card_instance_id: string) => void }) {
  return (
    <div className="sm-confirm-chip" data-testid="confirm-chip" data-card-id={card.card_instance_id} role="group" aria-label={cardTitle(card)}>
      <span className="sm-confirm-chip-text" data-testid="confirm-chip-readback">
        {proposalReadback(card, proposal)}
      </span>
      <span className="sm-confirm-chip-actions">
        <button type="button" className="sm-btn sm-btn-primary" data-testid="confirm-chip-confirm" onClick={() => onConfirm(proposalResolveRequest(card, proposal))} disabled={busy}>
          {copy("chip.confirm")}
        </button>
        <button type="button" className="sm-btn sm-btn-quiet" data-testid="confirm-chip-edit" onClick={() => onEdit(card.card_instance_id)} disabled={busy}>
          {copy("chip.edit")}
        </button>
      </span>
      {error ? (
        <span className="sm-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
