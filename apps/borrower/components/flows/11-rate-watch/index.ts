/**
 * 32.11 — Rate-watch and the re-refinance loop: the flow-specific UI. The shell renders whatever cards the API creates
 * (src/runtime/borrower/flows/11-rate-watch.ts); these helpers carry what a plain card or Record row cannot say by
 * itself: the OfferCard's §2 statements (the LE-style payment line, the no-cost line), the Loan section's Rate-watch
 * rows (what "worth it" means, the block's state — passive until an opportunity exists — and the standing connections
 * of DELTA-05 with the card that turns them off), and the funded StatusCard's autopay token, which the server names
 * by copy key (`refi.autopay.carried_over` · `refi.autopay.reauthorize` · `refi.autopay.none`) — never as a sentence.
 * No arithmetic: every rate and money figure is the owning row's own, formatted only.
 */
import { copy, copyOrUndefined, type Tokens } from "@/lib/copy";
import { formatMoney } from "@/lib/format";
import type { OfferCardProps, StatusCardProps } from "@/lib/types/cards";
import type { RecordLoan } from "@/lib/types/record";

export type RateWatchState = "passive" | "offer_open" | "in_progress";

/** The block's state line: the server's `state_copy_key`, else the key its `state` names; passive when the block has no opportunity (32.11 §1). */
export function rateWatchStateKey(rw: NonNullable<RecordLoan["ratewatch"]>): string {
  if (rw.state_copy_key) return rw.state_copy_key;
  const state: RateWatchState = rw.state ?? "passive";
  return state === "in_progress" ? "ratewatch.in_progress" : state === "offer_open" ? "ratewatch.offer_open" : "ratewatch.passive";
}

/** The standing-connections row (DELTA-05): on → the manage card in the thread is the act; off → the next conversion asks again; none → no row. */
export function standingConnectionsRow(l: RecordLoan): [string, string] | null {
  const sc = l.standing_connections;
  if (!sc || sc.status === "none") return null;
  return ["Standing connections", copy(sc.status === "active" ? "ratewatch.standing.on" : "ratewatch.standing.off")];
}

/** The Loan section's rows under the Rate-watch line: what "worth it" means, the block's state, the standing connections. */
export function rateWatchDetailRows(l: RecordLoan): [string, string][] {
  const rows: [string, string][] = [];
  const rw = l.ratewatch;
  if (rw) {
    rows.push(["Worth it", copy(rw.worth_it_copy_key ?? "ratewatch.worth_it")]);
    rows.push(["Rate-watch status", copy(rateWatchStateKey(rw))]);
  }
  const standing = standingConnectionsRow(l);
  if (standing) rows.push(standing);
  return rows;
}

/**
 * The OfferCard's §2 statements the card's figures do not say on their own: the LE-style payment statement and the
 * cost line (`costs_to_borrower_cents = 0` → the program-default no-cost line; anything else → the amount). The rates,
 * savings, lender, MLO attribution and expiry are the card's own rows and footer.
 */
export function offerLines(p: OfferCardProps): string[] {
  const term = p.term_months ?? 360;
  const costs = BigInt(p.costs_to_borrower_cents);
  return [
    copy("offer.payment_line", { n: term, money: formatMoney(p.new_pi_payment_cents) }),
    costs === 0n ? copy("offer.no_cost_line") : copy("offer.costs_line", { money: formatMoney(p.costs_to_borrower_cents) }),
  ];
}

/** `copy_token_keys` (a token named by copy key — 32.6 §5's mechanism) and the funded card's `autopay_copy_key` resolved into `copy_tokens`. */
export function withTokenKeys<P extends StatusCardProps & { autopay_copy_key?: string }>(p: P): P & { copy_tokens: Record<string, string | string[]> } {
  const tokens: Tokens = { ...(p.copy_tokens ?? {}) };
  for (const [name, key] of Object.entries(p.copy_token_keys ?? {})) {
    const text = copyOrUndefined(key);
    if (text !== undefined) tokens[name] = text;
  }
  if (p.autopay_copy_key && tokens["autopay"] === undefined) {
    const text = copyOrUndefined(p.autopay_copy_key);
    if (text !== undefined) tokens["autopay"] = text;
  }
  return { ...p, copy_tokens: tokens as Record<string, string | string[]> };
}
