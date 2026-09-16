/**
 * 32.19 §3 (docs/ux/18 §3.0–3.1) — the wiring every Apply screen shares, over the borrower API (`lib/api/client`):
 *
 *  - `resolveFirst(cards, key, body, fallback?)`: the pending card whose `copy_key === key` is resolved with
 *    `{evidence, option_id?, args?}` (the exact body the API reads, commands.ts); without the card a named fallback
 *    command runs; without either the values stay in the draft (`held`).
 *  - `waitForCard(key, ms)`: poll `GET /v1/borrower/thread` until a pending card of the key exists — the flows react
 *    asynchronously to the last commit (`du-journey.mts`'s `waitForCard`).
 *  - `flush(step, ctx)`: the per-step commit with the §3.1 evidence shapes. Session 1 wires `property` (the three
 *    branches: the addressed purchase, still looking, the refinance); the later steps post nothing yet.
 *  - `vendorSession(kind, ...)`: the FAKE vendor sessions, always `fake_complete: true` (a real vendor ignores it).
 *  - `messageOf(e)`: `ApiRequestError.body.copy_key` → `copy(copy_key)`, `error.generic` when the key is unknown —
 *    never the code; a local refusal (`StepError`) names its own copy key.
 *
 * Nothing here swallows a failure: every rejection reaches the step's `.sm-error` through `messageOf`.
 */
import { api, ApiRequestError } from "@/lib/api/client";
import { copy, isCopyKey } from "@/lib/copy";
import type { AnyCardInstance, ResolveRequest, Uuid } from "@/lib/types/cards";
import { cents, goalOptionOf, pending, resolved, type Draft, type Step } from "./apply-model";

/** A refusal raised before anything is posted (a required field empty); rendered as `copy(copyKey)`. */
export class StepError extends Error {
  constructor(public readonly copyKey: string) {
    super(copyKey);
    this.name = "StepError";
  }
}

export function messageOf(e: unknown): string {
  if (e instanceof StepError) return copy(e.copyKey);
  if (e instanceof ApiRequestError) return copy(isCopyKey(e.body.copy_key) ? e.body.copy_key : "error.generic");
  return copy("error.generic");
}

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The thread's cards as the API lists them (always an array — adapt.ts). */
export async function loadCards(): Promise<AnyCardInstance[]> {
  return (await api.thread()).cards;
}

/** Poll the thread until a pending card with `copy_key === key` exists; a timeout is an error the step shows. */
export async function waitForCard(key: string, ms = 30_000, pollMs = 500): Promise<AnyCardInstance> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = pending(await loadCards(), key);
    if (hit) return hit;
    if (Date.now() >= deadline) throw new StepError("error.generic");
    await sleep(pollMs);
  }
}

export type Fallback = { name: string; args: Record<string, unknown> };
export type ResolveOutcome = { kind: "resolved"; card_instance_id: Uuid } | { kind: "command"; name: string } | { kind: "held" };

/** The resolve-first rule (docs/ux/18 §3.0). `body.args` override the card's `command_args_by_option` (commands.ts:232). */
export async function resolveFirst(cards: readonly AnyCardInstance[], key: string, body: ResolveRequest, fallback?: Fallback, applicationId?: string | null): Promise<ResolveOutcome> {
  const card = pending(cards, key);
  if (card) {
    await api.resolveCard(card.card_instance_id, body);
    return { kind: "resolved", card_instance_id: card.card_instance_id };
  }
  if (fallback) {
    await api.command(fallback.name, { ...(applicationId ? { application_id: applicationId } : {}), ...fallback.args });
    return { kind: "command", name: fallback.name };
  }
  return { kind: "held" };
}

/** The FAKE vendor sessions on their pending ConnectCards — never `verification.connect` (docs/ux/18 §0.2 row 5). */
export async function vendorSession(kind: "identity", applicationId: string): Promise<unknown>;
export async function vendorSession(kind: "truv_income" | "plaid_assets", cardInstanceId: Uuid): Promise<unknown>;
export async function vendorSession(kind: "identity" | "truv_income" | "plaid_assets", id: string): Promise<unknown> {
  if (kind === "identity") return api.identitySession({ application_id: id, fake_complete: true } as { fake_complete?: boolean });
  return api.connectSession(kind, id, { fake_complete: true });
}

/** A confirmed field as the API reads it (`value_confirmed`, `source: borrower`, `confirmed_at`). */
export const confirmed = (path: string, value: string, at: string) => ({ path, value_confirmed: value, source: "borrower", confirmed_at: at });

/** The typed address with the state on its tail so `parseAddressLine` finds the state code ("24 Juniper Lane, Austin, TX 78701"). */
export function addressWithState(address: string, state: string): string {
  const typed = address.trim().replace(/,\s*$/, "");
  return /,\s*[A-Za-z]{2}(\s*\d{5}(?:-?\d{4})?)?$/.test(typed) ? typed : `${typed}, ${state.toUpperCase()}`;
}

export type FlushContext = { draft: Draft; cards: readonly AnyCardInstance[]; applicationId: string | null };
export type FlushResult = { next: Step; outcomes: ResolveOutcome[] };

const stateOf = (draft: Draft): string => draft.state.trim().toUpperCase();
const requireAll = (values: readonly string[]): void => {
  if (values.some((v) => !v.trim())) throw new StepError("apply.property.required");
};

/**
 * Property's Continue is the tap that resolves `entry.goal.question` on every branch (docs/ux/18 §3.0); the goal
 * screen only set the draft.
 *  - Buy with an address: the goal resolve with `args.property = {address, state}` (the flows read that address from
 *    21.1's intake record, so `application.received`'s reaction never treats the purchase as TBD and no `preapproval.*`
 *    card is sent — 3-entry.ts `isTbd`, DELTA-36), THEN `application.confirmField{path: property_address, fields: [six]}`
 *    (a command — no home card exists on a purchase; `propertyFacts` inserts the subject row with the estate and the
 *    lien). The plan's order (the command first) is refused by 21.1: a capture needs the interview the goal tap opens.
 *    Price and down stay in the draft.
 *  - Still looking: the goal resolve with `args.property = {tbd: true, state}`, then `preapproval.where` is awaited
 *    and resolved with the state, the range, the down payment and the first-time answer.
 *  - Refinance: the goal resolve with `lower_rate | cash_out`; the address, estate and lien stay in the draft until
 *    `refi.home.confirm` is sent (with the SSN card, on `application.field.captured{current_address}` — Session 2's
 *    You step flushes it).
 *  - Back on Property after the tap (Tasks → "Your home", or docs/ux/18 §2.2's "I have an address now" on a still-looking
 *    purchase): the goal card is resolved, not pending, so it is not awaited again (resolve-first: no card → the fallback,
 *    else hold); the addressed purchase runs `application.confirmField` (it completes the six items), still looking
 *    resolves `preapproval.where` only while it is pending, the refinance holds the draft.
 */
/** The goal card to tap: the pending one; none when it was already resolved (a return to Property); awaited when the flows have not sent it yet. */
async function goalCardOf(ctx: FlushContext): Promise<AnyCardInstance | null> {
  const key = "entry.goal.question";
  return pending(ctx.cards, key) ?? (resolved(ctx.cards, key) ? null : waitForCard(key));
}

export async function commitProperty(ctx: FlushContext): Promise<FlushResult> {
  const { draft, applicationId } = ctx;
  const option = goalOptionOf(draft);
  if (!option) throw new StepError("apply.goal.required");
  if (!applicationId) throw new StepError("apply.property.waiting");
  const state = stateOf(draft);
  const outcomes: ResolveOutcome[] = [];
  const at = now();
  if (option === "buy" && draft.shopping) {
    requireAll([state, draft.priceLow, draft.priceHigh, draft.down, draft.firstTimeBuyer]);
    if (!/^[A-Z]{2}$/.test(state)) throw new StepError("apply.property.required");
    const goal = await goalCardOf(ctx);
    if (goal) outcomes.push(await resolveFirst([goal], "entry.goal.question", { evidence: { option_id: "buy", tapped_at: at }, option_id: "buy", args: { occupancy: draft.occupancy, property: { tbd: true, state }, property_state: state } }));
    const where = goal ? await waitForCard("preapproval.where") : pending(ctx.cards, "preapproval.where");
    if (!where) return { next: "you", outcomes };
    const at2 = now();
    outcomes.push(await resolveFirst([where], "preapproval.where", { evidence: { fields: [
      confirmed("state", state, at2),
      confirmed("price_min_cents", cents(draft.priceLow), at2),
      confirmed("price_max_cents", cents(draft.priceHigh), at2),
      confirmed("down_payment_cents", cents(draft.down), at2),
      confirmed("first_time_buyer", draft.firstTimeBuyer, at2),
    ] } }));
    return { next: "you", outcomes };
  }
  requireAll([draft.property, state, draft.estateType, draft.cleanEnergyLien]);
  if (!/^[A-Z]{2}$/.test(state)) throw new StepError("apply.property.required");
  const address = addressWithState(draft.property, state);
  const goal = await goalCardOf(ctx);
  if (goal) outcomes.push(await resolveFirst([goal], "entry.goal.question", { evidence: { option_id: option, tapped_at: at }, option_id: option, args: { occupancy: draft.occupancy, property: { address, state }, property_state: state } }));
  if (option === "buy") {
    await api.command("application.confirmField", { application_id: applicationId, path: "property_address", fields: [
      { path: "property_address", value: address, source: "borrower" },
      { path: "estate_type", value: draft.estateType, source: "borrower" },
      { path: "existing_clean_energy_lien", value: draft.cleanEnergyLien, source: "borrower" },
      { path: "property_type", value: "sfr", source: "borrower" },
      { path: "units", value: "1", source: "borrower" },
      { path: "occupancy", value: draft.occupancy, source: "borrower" },
    ] });
    outcomes.push({ kind: "command", name: "application.confirmField" });
  }
  return { next: "you", outcomes };
}

/** The per-step commit. Steps not wired yet hold their values in the draft and post nothing (docs/ux/18 §5: Sessions 2–3). */
export async function flush(step: Step, ctx: FlushContext): Promise<FlushResult> {
  switch (step) {
    case "goal": {
      if (!goalOptionOf(ctx.draft)) throw new StepError("apply.goal.required");
      return { next: "property", outcomes: [] };
    }
    case "property": return commitProperty(ctx);
    case "you": return { next: "connect", outcomes: [] };
    case "connect": return { next: "details", outcomes: [] };
    case "details": return { next: "questions", outcomes: [] };
    case "questions": return { next: "demographics", outcomes: [] };
    case "demographics": return { next: "review", outcomes: [] };
    case "review": return { next: "result", outcomes: [] };
    case "result": return { next: "review", outcomes: [] };
  }
}
