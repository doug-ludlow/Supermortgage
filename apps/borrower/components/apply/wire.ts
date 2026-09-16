/**
 * 32.19 §3 (docs/ux/18 §3.0–3.1) — the wiring every Apply screen shares, over the borrower API (`lib/api/client`):
 *
 *  - `resolveFirst(cards, key, body, fallback?)`: the pending card whose `copy_key === key` is resolved with
 *    `{evidence, option_id?, args?}` (the exact body the API reads, commands.ts); without the card a named fallback
 *    command runs; without either the values stay in the draft (`held`).
 *  - `waitForCard(key, ms)`: poll `GET /v1/borrower/thread` until a pending card of the key exists — the flows react
 *    asynchronously to the last commit (`du-journey.mts`'s `waitForCard`).
 *  - `flush(step, ctx)`: the per-step commit with the §3.1 evidence shapes. Session 1 wired `property` (the three
 *    branches: the addressed purchase, still looking, the refinance); Session 2 wires `you` (the FAKE identity session,
 *    the identity, SSN, prior-residence and — on a refinance — the home card), `connect` (the two FAKE connections and the
 *    income card) and `details` (the profile card); Session 3 wires `review` (the number cards — the readiness view's one
 *    CTA; `preapproval.target` on a still-looking purchase) and the card-hosted steps' follow-through (`waitAfterDeclaration`:
 *    the next question of the declarations sequence, or its end). Questions and Demographics post through the card
 *    components themselves (`ApplyProduct.onResolveCard`); Result posts nothing (the DU moment is the flows' own run).
 *  - `vendorSession(kind, ...)`: the FAKE vendor sessions, always `fake_complete: true` (a real vendor ignores it).
 *  - `messageOf(e)`: `ApiRequestError.body.copy_key` → `copy(copy_key)`, `error.generic` when the key is unknown —
 *    never the code; a local refusal (`StepError`) names its own copy key.
 *
 * Nothing here swallows a failure: every rejection reaches the step's `.sm-error` through `messageOf`.
 */
import { api, ApiRequestError } from "@/lib/api/client";
import { copy, isCopyKey } from "@/lib/copy";
import type { AnyCardInstance, ResolveRequest, Uuid } from "@/lib/types/cards";
import type { BorrowerRecord } from "@/lib/types/record";
import { cents, goalOptionOf, isTbdPurchase, pending, pendingDeclaration, resolved, uniqueCards, type Draft, type Step } from "./apply-model";

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

/** The thread's cards as the API lists them (always an array — adapt.ts), one entry per card. */
export async function loadCards(): Promise<AnyCardInstance[]> {
  return uniqueCards((await api.thread()).cards);
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

export type FlushContext = { draft: Draft; cards: readonly AnyCardInstance[]; applicationId: string | null; record?: BorrowerRecord | null };
/** `patch` is applied to the draft after the commit (the SSN is held only until its card is written — never echoed, never kept). */
export type FlushResult = { next: Step; outcomes: ResolveOutcome[]; patch?: Partial<Draft> };

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
  const { applicationId } = ctx;
  // the branch: the draft's intent, else the record's purpose (a reload after the goal tap — the card is resolved and the page holds no intent)
  const purpose = ctx.record?.header.purpose;
  const draft: Draft = ctx.draft.intent === null && (purpose === "Buying" || purpose === "Refinancing") ? { ...ctx.draft, intent: purpose === "Buying" ? "purchase" : "refinance", refiGoal: ctx.record?.subject.transaction_type === "cash_out" ? "cash" : ctx.draft.refiGoal } : ctx.draft;
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

/** The card to resolve for a step: the pending one; none when it was already resolved (a return to the step); awaited when the flows have not sent it yet. */
async function cardOf(cards: readonly AnyCardInstance[], key: string, ms?: number): Promise<AnyCardInstance | null> {
  return pending(cards, key) ?? (resolved(cards, key) ? null : waitForCard(key, ms));
}
/** A ConfirmCard's evidence: every field the card shows, `edits` overriding by path as the borrower's own (`source: borrower` — 21.1 rule 1; the API marks a changed value `edited` too). */
export function fieldsEvidence(card: AnyCardInstance, edits: Record<string, string>, at: string): ResolveRequest {
  const shown = card.kind === "ConfirmCard" ? card.props.fields : [];
  const fields = shown.map((f) => ({ path: f.path, value_confirmed: edits[f.path] ?? f.value ?? "", source: edits[f.path] !== undefined ? "borrower" as const : f.source ?? "borrower", confirmed_at: at }));
  for (const [path, value] of Object.entries(edits)) if (!fields.some((f) => f.path === path)) fields.push({ path, value_confirmed: value, source: "borrower", confirmed_at: at });
  return { evidence: { fields, edited: Object.keys(edits).length > 0 } };
}
const digitsOf = (v: string): string => v.replace(/\D/g, "");
const monthsOf = (v: string): string => digitsOf(v).replace(/^0+(?=\d)/, "");
/** docs/ux/18 §2.2: the prior-address panel (SQ-06) opens when the stay at the current address is under 24 months. */
export const underTwoYears = (months: string): boolean => { const m = monthsOf(months); return m !== "" && BigInt(m) < 24n; };

/**
 * You (docs/ux/18 §2.2 you, §2.4 you): (1) the FAKE identity session on the pending `identity.stripe.purpose` card
 * (`POST identity/stripe/session {application_id, fake_complete}` — the vendor's settlement resolves the connector, writes the
 * prefill and raises L3; the page posts no `credit.authorize` and asks for no L2), then the identity card is awaited;
 * (2) `identity.confirm.title` resolved with the typed name, birth date, residence basis, rent and months as edits (the
 * current address is the card's own); (3) `identity.ssn.title` awaited and resolved with the nine digits (stored once,
 * masked in the evidence, never echoed — the draft drops them after the write); (4) `identity.prior_residence.title` when
 * the months are under 24 (sent with the SSN card); (5) on a refinance, `refi.home.confirm` (sent with the SSN card on
 * `application.field.captured{current_address}`) resolved with the held address, estate type and lien — the six-item
 * address and the subject row. Each card is resolved only while pending: a return to You after a refusal picks up where
 * the writes stopped (resolve-first; no second session, no second tap).
 */
export async function commitYou(ctx: FlushContext): Promise<FlushResult> {
  const { draft, applicationId } = ctx;
  if (!applicationId) throw new StepError("apply.property.waiting");
  const legalName = draft.legalName.trim(); const dob = draft.dob.trim(); const ssn = digitsOf(draft.ssn); const months = monthsOf(draft.months);
  const identityDone = Boolean(resolved(ctx.cards, "identity.confirm.title")); const ssnDone = Boolean(resolved(ctx.cards, "identity.ssn.title"));
  if (!identityDone && (!legalName || !/^\d{4}-\d{2}-\d{2}$/.test(dob) || !/^\d{1,3}$/.test(months))) throw new StepError("apply.you.required");
  if (!identityDone && draft.housing === "rent" && !digitsOf(draft.rent)) throw new StepError("apply.you.rent_required");
  if (!ssnDone && ssn.length !== 9) throw new StepError("apply.you.ssn_invalid");
  const prior = (underTwoYears(draft.months) || Boolean(pending(ctx.cards, "identity.prior_residence.title"))) && !resolved(ctx.cards, "identity.prior_residence.title");   // SQ-06: the typed months, or the card still pending (a return with an empty draft)
  if (prior && (!draft.priorAddressLine.trim() || !draft.priorCity.trim() || !/^[A-Za-z]{2}$/.test(draft.priorState.trim()) || !/^\d{5}(\d{4})?$/.test(digitsOf(draft.priorZip)) || !/^\d{1,3}$/.test(monthsOf(draft.priorMonths)))) throw new StepError("apply.you.prior_required");
  if (prior && draft.priorBasis === "rent" && !digitsOf(draft.priorRent)) throw new StepError("apply.you.rent_required");
  const outcomes: ResolveOutcome[] = [];
  let cards = ctx.cards;
  // (1) the ID scan: the FAKE finishes on the tap; the flows send the identity card on identity.verified
  if (!identityDone && !pending(cards, "identity.confirm.title")) {
    if (pending(cards, "identity.stripe.purpose")) { await vendorSession("identity", applicationId); outcomes.push({ kind: "command", name: "identity.stripe.session" }); }
    cards = [await waitForCard("identity.confirm.title")];
  }
  // (2) the identity card: the typed values as edits, the residence basis and the months (the tap writes the Current du_residences row)
  const identity = pending(cards, "identity.confirm.title");
  if (identity) {
    const edits: Record<string, string> = { legal_name: legalName, date_of_birth: dob, residency_basis: draft.housing, months_at_address: months };
    if (draft.housing === "rent") edits["monthly_rent_cents"] = cents(draft.rent);
    outcomes.push(await resolveFirst([identity], "identity.confirm.title", fieldsEvidence(identity, edits, now())));
  }
  // (3) the SSN card (sent on application.field.captured{current_address}): the one typed field, nine digits, once
  const ssnCard = await cardOf(ssnDone ? ctx.cards : await loadCards(), "identity.ssn.title");
  if (ssnCard) outcomes.push(await resolveFirst([ssnCard], "identity.ssn.title", { evidence: { fields: [confirmed("ssn", ssn, now())], edited: true } }));
  // (4) SQ-06: the prior residence when the stay is under two years (the card rides with the SSN card; awaited only when this Continue's identity tap sent it)
  if (prior) {
    const card = identity ? await cardOf(await loadCards(), "identity.prior_residence.title") : pending(await loadCards(), "identity.prior_residence.title") ?? null;
    if (card) {
      const edits: Record<string, string> = { prior_address_line: draft.priorAddressLine.trim(), prior_city: draft.priorCity.trim(), prior_state: draft.priorState.trim().toUpperCase(), prior_postal_code: digitsOf(draft.priorZip), prior_residency_basis: draft.priorBasis, prior_months_at_address: monthsOf(draft.priorMonths) };
      if (draft.priorBasis === "rent") edits["prior_monthly_rent_cents"] = cents(draft.priorRent);
      outcomes.push(await resolveFirst([card], "identity.prior_residence.title", fieldsEvidence(card, edits, now())));
    }
  }
  // (5) the refinance's home card, held since Property: the address, estate type and lien → the six-item address and the subject row.
  // The card rides the identity tap's `application.field.captured{current_address}` asynchronously, so on a refinance it is awaited — by the draft's intent, or by the
  // record's purpose when the draft is empty (a reload between Property and You: the answers are asked again on the card, and the API refuses a bare tap — 32.19-T13).
  const fresh = await loadCards();
  const refinance = draft.intent === "refinance" || (draft.intent === null && ctx.record?.header.purpose === "Refinancing");
  const home = refinance ? await cardOf(fresh, "refi.home.confirm") : pending(fresh, "refi.home.confirm") ?? null;
  if (home) {
    const state = stateOf(draft);
    const edits: Record<string, string> = {};
    if (draft.property.trim()) edits["property_address"] = /^[A-Z]{2}$/.test(state) ? addressWithState(draft.property, state) : draft.property.trim();
    if (draft.estateType) edits["estate_type"] = draft.estateType;
    if (draft.cleanEnergyLien) edits["existing_clean_energy_lien"] = draft.cleanEnergyLien;
    if (draft.intent) edits["occupancy"] = draft.occupancy;
    outcomes.push(await resolveFirst([home], "refi.home.confirm", fieldsEvidence(home, edits, now())));
  }
  return { next: "connect", outcomes, patch: { ssn: "" } };
}

/**
 * Connect (docs/ux/18 §2.2 connect): (1) the FAKE payroll connection on the pending `income.connect.purpose` card
 * (`POST connect/truv_income/session {card_instance_id, fake_complete}` — the route resolves the connector and orders 22.3;
 * `verification.received{income}` sends the income card), awaited; (2) `income.confirm.title` resolved with the typed
 * monthly income and employer as edits over the report's figures; (3) the FAKE assets connection on the pending
 * `assets.connect.purpose` card (`verification.received{assets}`, the card connected). The page never posts
 * `verification.connect`; no Skip in v1 (§2.5).
 */
export async function commitConnect(ctx: FlushContext): Promise<FlushResult> {
  const { draft, applicationId } = ctx;
  if (!applicationId) throw new StepError("apply.property.waiting");
  const incomeDone = Boolean(resolved(ctx.cards, "income.confirm.title"));
  if (!incomeDone && (!digitsOf(draft.income) || !draft.employer.trim())) throw new StepError("apply.connect.required");
  const outcomes: ResolveOutcome[] = [];
  let cards = ctx.cards;
  if (!incomeDone && !pending(cards, "income.confirm.title")) {
    const payroll = pending(cards, "income.connect.purpose");
    if (payroll) { await vendorSession("truv_income", payroll.card_instance_id); outcomes.push({ kind: "command", name: "connect.truv_income.session" }); }
    cards = [await waitForCard("income.confirm.title")];
  }
  const income = pending(cards, "income.confirm.title");
  if (income) outcomes.push(await resolveFirst([income], "income.confirm.title", fieldsEvidence(income, { employer: draft.employer.trim(), monthly_base_cents: cents(draft.income) }, now())));
  const assets = pending(await loadCards(), "assets.connect.purpose");
  if (assets) { await vendorSession("plaid_assets", assets.card_instance_id); outcomes.push({ kind: "command", name: "connect.plaid_assets.session" }); }
  return { next: "details", outcomes };
}

/**
 * Details (docs/ux/18 §2.2 details): the profile card (`profile.title`, sent on the six-item income) resolved with
 * `option_id: submit` and the five fields — the card's own option ids; the required four are checked here first (the
 * step stays with `.sm-error` and posts nothing when one is empty). Married → `apply.details.spouse_later` renders;
 * no `application.inviteParty` is posted (co-borrower out of v1).
 */
export async function commitDetails(ctx: FlushContext): Promise<FlushResult> {
  const { draft } = ctx;
  const dependents = digitsOf(draft.dependents);
  if (!draft.citizenship || !draft.marital || !dependents || !draft.military) throw new StepError("apply.details.required");
  const outcomes: ResolveOutcome[] = [];
  const card = await cardOf(ctx.cards, "profile.title");
  if (card) {
    const at = now();
    const answers: Record<string, string> = { citizenship_status: draft.citizenship, marital_status: draft.marital, dependents, military_service: draft.military, language_preference: draft.language || "not_answered" };
    outcomes.push(await resolveFirst([card], "profile.title", { option_id: "submit", evidence: { fields: Object.entries(answers).map(([path, value]) => ({ path, value, answered_at: at })) } }));
  }
  return { next: "questions", outcomes };
}

/** `a − b` and `a + b` over decimal strings of cents — BigInt, never a float (32.13-T9). */
const minus = (a: string, b: string): string => (BigInt(a) - BigInt(b)).toString();
const plus = (a: string, b: string): string => (BigInt(a) + BigInt(b)).toString();
const shownValue = (card: AnyCardInstance | null, path: string): string => (card && card.kind === "ConfirmCard" ? card.props.fields.find((f) => f.path === path)?.value ?? "" : "");

/**
 * The amount card's edits (docs/ux/18 §2.2 review, §2.4): the loan amount — price − down on the addressed purchase (DELTA-32; the down payment must be typed,
 * a "0" counts, never price − nothing), the balance (+ the cash out on a cash-out, DELTA-33) on a refinance, nothing when the card's own figure stands — and, on a
 * cash-out, what the cash is for (DELTA-37: `cash_out_purpose`, a MISMO id the card requires; empty → `apply.review.required` before anything is posted, the
 * same refusal the API would give as 409 CARD_FIELD_REQUIRED). `requiredPaths` is the card's own list, so a reloaded draft whose goal was seeded from the record
 * still learns the ask from the card.
 */
export function amountEdits(draft: Draft, purchase: boolean, requiredPaths: readonly string[] = []): Record<string, string> {
  let amount = "";
  if (purchase) { if (digitsOf(draft.price)) { if (!draft.down.trim()) throw new StepError("apply.review.required"); const price = cents(draft.price); const down = cents(draft.down); if (BigInt(down) > BigInt(price)) throw new StepError("apply.review.required"); amount = minus(price, down); } }
  else if (digitsOf(draft.balance)) amount = draft.refiGoal === "cash" && digitsOf(draft.cashOut) ? plus(cents(draft.balance), cents(draft.cashOut)) : cents(draft.balance);
  const edits: Record<string, string> = amount ? { loan_amount_sought: amount } : {};
  if (!purchase && (draft.refiGoal === "cash" || requiredPaths.includes("cash_out_purpose"))) {
    if (!draft.cashOutPurpose.trim()) throw new StepError("apply.review.required");
    edits["cash_out_purpose"] = draft.cashOutPurpose.trim();
  }
  return edits;
}

/**
 * Review (docs/ux/18 §2.2 review, §2.3, §2.4): the readiness view's one CTA — "Confirm these numbers" — is the last number
 * cards' tap; nothing submits (owner decision 1; the DU moment is the flows' own run on `application.trid_received`).
 *  - An addressed purchase: `refi.value.confirm` ← the price, `refi.loan_amount.confirm` ← price − down payment,
 *    `refi.product.choice` FRM30.
 *  - A refinance: the value ← "worth" (the FAKE AVM's figure stands when nothing was typed), the loan amount ← the balance
 *    (+ the cash out on `cash_out`, with what the cash is for — DELTA-37), the product FRM30 or FRM15 (Pay off sooner). A pending `refi.current_loan.confirm`
 *    (after the report) takes the typed balance as `current_balance_cents` — the same number, the same tap.
 *  - Still looking: `preapproval.target` ← the price high, the down payment, high − down, FRM30; the file stays received.
 * Each card is resolved only while pending (resolve-first): a return to Review after the tap posts nothing and goes to Result.
 */
export async function commitReview(ctx: FlushContext): Promise<FlushResult> {
  const { draft, applicationId } = ctx;
  if (!applicationId) throw new StepError("apply.property.waiting");
  const outcomes: ResolveOutcome[] = [];
  const at = now();
  // the number cards (or preapproval.target) ride application.demographics.collected: while a question or the demographics card is still
  // pending (Tasks → Review early) there is no card to wait for — the step stays with the ask named and nothing is posted (§3.0), never a 30 s wait
  if (!pending(ctx.cards, "refi.value.confirm") && !resolved(ctx.cards, "refi.value.confirm") && !pending(ctx.cards, "preapproval.target") && !resolved(ctx.cards, "preapproval.target")) {
    if (pendingDeclaration(ctx.cards)) throw new StepError("apply.questions.answer_first");
    if (pending(ctx.cards, "demographics.title")) throw new StepError("apply.demographics.answer_first");
  }
  if (isTbdPurchase(ctx.cards, ctx.record ?? null)) {
    const target = await cardOf(ctx.cards, "preapproval.target");
    if (target) {
      const high = draft.priceHigh.trim() || draft.price.trim();
      if (!digitsOf(high) || !draft.down.trim()) throw new StepError("apply.review.required");
      const price = cents(high); const down = cents(draft.down);
      if (BigInt(down) > BigInt(price)) throw new StepError("apply.review.required");
      outcomes.push(await resolveFirst([target], "preapproval.target", { evidence: { fields: [confirmed("target_price_cents", price, at), confirmed("down_payment_cents", down, at), confirmed("loan_amount_sought", minus(price, down), at), confirmed("product_code", "FRM30", at)], edited: true } }));
    }
    return { next: "result", outcomes };
  }
  const purchase = draft.intent === "purchase";
  // the three cards ride application.demographics.collected together; the value card is awaited when none has arrived yet
  let cards = ctx.cards;
  if (!pending(cards, "refi.value.confirm") && !resolved(cards, "refi.value.confirm")) { await waitForCard("refi.value.confirm"); cards = await loadCards(); }
  const valueCard = pending(cards, "refi.value.confirm") ?? null;
  if (valueCard) {
    const typed = purchase ? draft.price.trim() : draft.value.trim();
    const value = digitsOf(typed) ? cents(typed) : shownValue(valueCard, "property_value_estimate");
    if (!digitsOf(value)) throw new StepError("apply.review.required");
    outcomes.push(await resolveFirst([valueCard], "refi.value.confirm", fieldsEvidence(valueCard, digitsOf(typed) ? { property_value_estimate: value } : {}, now())));
  }
  const amountCard = pending(cards, "refi.loan_amount.confirm") ?? null;
  if (amountCard) {
    const edits = amountEdits(draft, purchase, amountCard.kind === "ConfirmCard" ? amountCard.props.required_paths ?? [] : []);
    if (!edits["loan_amount_sought"] && !digitsOf(shownValue(amountCard, "loan_amount_sought"))) throw new StepError("apply.review.required");
    outcomes.push(await resolveFirst([amountCard], "refi.loan_amount.confirm", fieldsEvidence(amountCard, edits, now())));
  }
  const productCard = pending(cards, "refi.product.choice") ?? null;
  if (productCard) {
    const option = !purchase && draft.refiGoal === "faster" ? "FRM15" : "FRM30";
    outcomes.push(await resolveFirst([productCard], "refi.product.choice", { option_id: option, evidence: { option_id: option, tapped_at: now() } }));
  }
  // after the report (§2.4): the current-loan card takes the typed balance — the same number the borrower confirmed above
  const current = pending(cards, "refi.current_loan.confirm") ?? null;
  if (current && !purchase && digitsOf(draft.balance)) outcomes.push(await resolveFirst([current], "refi.current_loan.confirm", fieldsEvidence(current, { current_balance_cents: cents(draft.balance) }, now())));
  return { next: "result", outcomes };
}

/**
 * After a declarations card's tap (Questions hosts the card component; the tap is the resolve): the flows send the next
 * question on `BorrowerFlows.cardResolved`, asynchronously — poll until a different `declarations.*` card is pending, the
 * sequence has ended (`demographics.title` pending, or nothing of the family pending after the last tap ran the command),
 * or the wait runs out. Returns the thread's cards as last read.
 */
export async function waitAfterDeclaration(tappedId: Uuid, ms = 20_000, pollMs = 400): Promise<AnyCardInstance[]> {
  const started = Date.now();
  // the tap committed; a read the edge throttled (429 — deploy 191, three tabs on one IP) or that never arrived is retried (null), never the tap's error; the borrower's own refusal (401, 409) still throws
  const read = async (): Promise<AnyCardInstance[] | null> => { try { return await loadCards(); } catch (e) { if (e instanceof ApiRequestError && e.status !== 429 && e.status < 500) throw e; return null; } };
  let cards = (await read()) ?? [];
  for (;;) {
    const next = pendingDeclaration(cards);
    if (next && next.card_instance_id !== tappedId) return cards;
    if (pending(cards, "demographics.title") || resolved(cards, "demographics.title")) return cards;
    const tapped = cards.find((c) => c.card_instance_id === tappedId);
    if (tapped && tapped.status !== "pending" && !next && Date.now() - started >= 3_000) return cards;   // the tap was the sequence's last and nothing followed within 3 s (the demographics card is on its way, or not owed on this file)
    if (Date.now() - started >= ms) return cards;
    await sleep(pollMs);
    const fresh = await read(); if (fresh) cards = fresh; else await sleep(pollMs * 5);
  }
}

/** The per-step commit. Questions and Demographics post through their hosted cards (`ApplyProduct.onResolveCard`); Result posts nothing. */
export async function flush(step: Step, ctx: FlushContext): Promise<FlushResult> {
  switch (step) {
    case "goal": {
      if (!goalOptionOf(ctx.draft)) throw new StepError("apply.goal.required");
      return { next: "property", outcomes: [] };
    }
    case "property": return commitProperty(ctx);
    case "you": return commitYou(ctx);
    case "connect": return commitConnect(ctx);
    case "details": return commitDetails(ctx);
    case "questions": {
      if (pendingDeclaration(ctx.cards)) throw new StepError("apply.questions.answer_first");   // the sequence is answered one tap at a time on the card; Continue never skips a question
      return { next: "demographics", outcomes: [] };
    }
    case "demographics": {
      if (pending(ctx.cards, "demographics.title")) throw new StepError("apply.demographics.answer_first");
      return { next: "review", outcomes: [] };
    }
    case "review": return commitReview(ctx);
    case "result": return { next: "review", outcomes: [] };
  }
}
