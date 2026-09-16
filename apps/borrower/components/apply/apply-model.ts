/**
 * 32.19 (docs/ux/18 §2.0, §3.0) — the Apply product's state: the tabs, the door, the nine steps, the seven tasks
 * (`TaskId = Exclude<Step, "goal" | "result">`), the typed `Draft`, and the pure helpers the screens and `wire.ts`
 * share: `pending()` (an exact `copy_key` match — the `declarations.*` family resolves one card at a time),
 * `cents()` (a typed amount → an integer string of cents with no float arithmetic; 32.13-T9, lint-money),
 * `doneFrom()` (each task's done state derived from the card statuses and the record on every render, never
 * remembered) and `STEP_OF_COPY_KEY` (`?card=` → the step that owns the card).
 */
import type { AnyCardInstance } from "@/lib/types/cards";
import type { BorrowerRecord } from "@/lib/types/record";

export type Tab = "apply" | "chat" | "loan" | "tasks" | "account";
export type Door = "welcome" | "intro" | "account";
export type Step =
  | "goal"
  | "property"
  | "you"
  | "connect"
  | "details"
  | "questions"
  | "demographics"
  | "review"
  | "result";
export type TaskId = Exclude<Step, "goal" | "result">;
export type Intent = "purchase" | "refinance" | null;
export type RefiGoal = "lower" | "faster" | "cash";
export type Occupancy = "primary" | "second_home" | "investment";
export type EstateType = "" | "fee_simple" | "leasehold";
export type YesNo = "" | "yes" | "no";
/** The residence basis as the identity and prior-residence cards' option ids name it (RESIDENCY_BASIS_OPTIONS: own · rent · living_rent_free). */
export type Basis = "own" | "rent" | "living_rent_free";
export const BASES: readonly Basis[] = ["own", "rent", "living_rent_free"];
export type Citizenship = "" | "us_citizen" | "permanent_resident" | "non_permanent_resident";
export type Marital = "" | "unmarried" | "married" | "separated";
export type Military = "" | "none" | "active_duty" | "retired_or_separated" | "reserve_or_guard" | "surviving_spouse";
export type Language = "" | "english" | "spanish" | "chinese" | "korean" | "tagalog" | "vietnamese" | "other" | "not_answered";
/** The profile card's option ids in the order the copy library's `apply.details.*` options list them (3-entry.ts profileCard). */
export const CITIZENSHIPS: readonly Exclude<Citizenship, "">[] = ["us_citizen", "permanent_resident", "non_permanent_resident"];
export const MARITALS: readonly Exclude<Marital, "">[] = ["unmarried", "married", "separated"];
export const MILITARIES: readonly Exclude<Military, "">[] = ["none", "active_duty", "retired_or_separated", "reserve_or_guard", "surviving_spouse"];
export const LANGUAGES: readonly Exclude<Language, "">[] = ["english", "spanish", "chinese", "korean", "tagalog", "vietnamese", "other", "not_answered"];

export type Draft = {
  intent: Intent;
  refiGoal: RefiGoal;
  occupancy: Occupancy;
  shopping: boolean;
  property: string;
  state: string;
  price: string;
  priceLow: string;
  priceHigh: string;
  down: string;
  firstTimeBuyer: YesNo;
  estateType: EstateType;
  cleanEnergyLien: YesNo;
  value: string;
  balance: string;
  cashOut: string;
  legalName: string;
  dob: string;
  ssn: string;
  housing: Basis;
  rent: string;
  months: string;
  priorAddressLine: string;
  priorCity: string;
  priorState: string;
  priorZip: string;
  priorBasis: Basis;
  priorRent: string;
  priorMonths: string;
  income: string;
  employer: string;
  citizenship: Citizenship;
  marital: Marital;
  dependents: string;
  military: Military;
  language: Language;
};

export const EMPTY: Draft = {
  intent: null,
  refiGoal: "lower",
  occupancy: "primary",
  shopping: false,
  property: "",
  state: "",
  price: "",
  priceLow: "",
  priceHigh: "",
  down: "",
  firstTimeBuyer: "",
  estateType: "",
  cleanEnergyLien: "",
  value: "",
  balance: "",
  cashOut: "",
  legalName: "",
  dob: "",
  ssn: "",
  housing: "own",
  rent: "",
  months: "36",
  priorAddressLine: "",
  priorCity: "",
  priorState: "",
  priorZip: "",
  priorBasis: "rent",
  priorRent: "",
  priorMonths: "",
  income: "",
  employer: "",
  citizenship: "",   // no visual default counts as an answer (01 §3.18): the four required profile facts are empty until chosen
  marital: "",
  dependents: "",
  military: "",
  language: "",
};

/** The seven tasks in order; the row labels are `apply.tasks.rows`' options in the same order. */
export const TASKS: readonly TaskId[] = ["property", "you", "connect", "details", "questions", "demographics", "review"];
export const STEPS: readonly Step[] = ["goal", "property", "you", "connect", "details", "questions", "demographics", "review", "result"];

/** The step a card's copy key belongs to (docs/ux/18 §3.3); a key not listed lands on Tasks with the card expanded. */
export const STEP_OF_COPY_KEY: Readonly<Record<string, Step>> = {
  "entry.goal.question": "goal",
  "preapproval.where": "property",
  "refi.home.confirm": "property",
  "identity.stripe.purpose": "you",
  "identity.confirm.title": "you",
  "identity.ssn.title": "you",
  "identity.prior_residence.title": "you",
  "credit.freeze.lift": "you",   // 32.16-T14: a frozen bureau's lift instructions are the You step's caution row
  "income.connect.purpose": "connect",
  "income.confirm.title": "connect",
  "assets.connect.purpose": "connect",
  "income.upload.fallback": "connect",   // 32.13-T12: a failed payroll connection's document fallback (13-cross-cutting) is the Connect step's
  "documents.upload.fallback": "connect",   // the other connectors' fallback (assets), the same step
  "preapproval.intro": "property",   // the still-looking purchase's intro line (a StatusCard — never a task; `?card=` lands on Property)
  "profile.title": "details",
  "demographics.title": "demographics",
  "refi.value.confirm": "review",
  "refi.loan_amount.confirm": "review",
  "refi.product.choice": "review",
  "preapproval.target": "review",
  "du.running": "result",   // the copy library's line while underwriting runs (32.18 rule 3) — read on Result, never a task
  "conditions.checklist": "result",   // the ChecklistCard when it comes (32.3 R8)
};
export function stepOfCopyKey(copyKey: string): Step | undefined {
  const listed = STEP_OF_COPY_KEY[copyKey];
  if (listed) return listed;
  // the families docs/ux/18 §3.3 names by prefix: `identity.*` → you, `income.*` / `assets.*` → connect, `declarations.*` → questions, `preapproval.*` → property (the target is Review's, listed above)
  if (copyKey.startsWith("declarations.")) return "questions";
  if (copyKey.startsWith("identity.")) return "you";
  if (copyKey.startsWith("income.") || copyKey.startsWith("assets.")) return "connect";
  if (copyKey.startsWith("preapproval.")) return "property";
  return undefined;
}
/** 32.18 rule 7: a card the assembly re-sent for a gap it found (`flow_key` `…:gap:<emission>`) — hosted in Tasks and listed on Review/Result with the copy library's `application.gap.resend` line, never folded back into a step's form. */
export function isGapCard(card: AnyCardInstance): boolean {
  const flowKey = (card.props as { flow_key?: unknown }).flow_key;
  return typeof flowKey === "string" && flowKey.includes(":gap:");
}
/** The step that hosts a card: the interview's own cards by copy key; a re-sent gap card has no step (Tasks hosts it). */
export function stepOfCard(card: AnyCardInstance): Step | undefined {
  return isGapCard(card) ? undefined : stepOfCopyKey(card.copy_key);
}
/** Kinds with nothing of the borrower's to tap (01 §3; the rail's HOMED_ELSEWHERE): never a task, never under "Still needed" — Result reads the status and the checklist, My Loan the notices and people. */
export const INFORMATIONAL_KINDS: ReadonlySet<string> = new Set(["StatusCard", "PersonCard", "ChecklistCard", "HandoffCard", "NoticeCard"]);
/** The pending cards that are asks (a control to tap), newest last. */
export function neededCards(cards: readonly AnyCardInstance[]): AnyCardInstance[] {
  return cards.filter((c) => c.status === "pending" && !INFORMATIONAL_KINDS.has(c.kind));
}
/** The pending asks with no step of their own — a gap card, `credit.liabilities.confirm`, `refi.current_loan.confirm`, a 33.x OfferCard — hosted in Tasks through `components/cards` (docs/ux/18 §2.3). */
export function hostedInTasks(cards: readonly AnyCardInstance[]): AnyCardInstance[] {
  return neededCards(cards).filter((c) => !stepOfCard(c));
}
/** The interview's pending `declarations.*` card (one question at a time; a gap re-send is Tasks' — `isGapCard`), the oldest first. */
export function pendingDeclaration(cards: readonly AnyCardInstance[]): AnyCardInstance | undefined {
  return cards.filter((c) => c.status === "pending" && c.copy_key.startsWith("declarations.") && !isGapCard(c)).sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0];
}
/**
 * docs/ux/18 §2.3 (still looking): the purchase is to-be-determined when the goal tap carried `{tbd: true}` (the card's
 * `command_output.property_tbd`) or `preapproval.where` was sent, and no address has reached the record since —
 * `record.property` is null without an `application_properties` row, so the card is the source, not the record.
 */
export function isTbdPurchase(cards: readonly AnyCardInstance[], record: BorrowerRecord | null): boolean {
  if (record?.property?.address) return false;
  const goal = resolved(cards, "entry.goal.question");
  const out = (goal?.evidence as { command_output?: { property_tbd?: unknown } } | undefined)?.command_output;
  return out?.property_tbd === true || cards.some((c) => c.copy_key === "preapproval.where") || Boolean(resolved(cards, "preapproval.target"));
}

/**
 * A typed amount ("650,000", "$1,234.5", "12.345") → cents as a decimal string, with no float arithmetic
 * (32.13-T9): the digits before the point are the dollars, the first two after it the cents (padded), `BigInt` does
 * the rest. Anything that is not a digit or a point is dropped; an empty or malformed value is "0".
 */
export function cents(raw: string): string {
  const cleaned = String(raw).replace(/[^0-9.]/g, "");
  if (!cleaned) return "0";
  const [dollars = "", fraction = ""] = cleaned.split(".");
  const whole = dollars.replace(/\D/g, "") || "0";
  const frac = (fraction.replace(/\D/g, "") + "00").slice(0, 2);
  return BigInt(`${whole}${frac}`).toString();
}

/** The thread lists a card once per message that carries it (a card's own line and, for a gap re-send, the `application.gap.resend` line beside it): one entry per card id, the last wins. */
export function uniqueCards(cards: readonly AnyCardInstance[]): AnyCardInstance[] {
  const byId = new Map<string, AnyCardInstance>();
  for (const c of cards) byId.set(c.card_instance_id, c);
  return [...byId.values()];
}
/** The pending card whose copy key is exactly `key` (never `startsWith`: `declarations.title` is not `declarations.title.x`). */
export function pending(cards: readonly AnyCardInstance[], key: string): AnyCardInstance | undefined {
  return cards.find((c) => c.status === "pending" && c.copy_key === key);
}
/** A card of the key that has been resolved (the tap happened); the newest wins when the key was re-sent. */
export function resolved(cards: readonly AnyCardInstance[], key: string): AnyCardInstance | undefined {
  return cards.filter((c) => c.status === "resolved" && c.copy_key === key).at(-1);
}

/**
 * docs/ux/18 §3.0: `done[taskId]` is derived, never remembered. property = the goal card resolved and (the
 * address on the record, or `preapproval.where` / `refi.home.confirm` resolved); you = `identity.ssn.title`
 * resolved; connect = the income card resolved and the assets card not pending; details = `profile.title`
 * resolved; questions = a `declarations.*` card resolved and none pending; demographics = `demographics.title`
 * resolved; review = the number cards resolved (`refi.product.choice`, or `preapproval.target` on a TBD purchase).
 */
export function doneFrom(cards: readonly AnyCardInstance[], record: BorrowerRecord | null): Record<TaskId, boolean> {
  const goal = Boolean(resolved(cards, "entry.goal.question"));
  const address = Boolean(record?.property?.address) && record?.property?.tbd !== true;
  const declarations = cards.filter((c) => c.copy_key.startsWith("declarations.") && !isGapCard(c));   // a re-sent gap card is its own task (Tasks hosts it), not the row's state
  return {
    property: goal && (address || Boolean(resolved(cards, "preapproval.where")) || Boolean(resolved(cards, "refi.home.confirm"))),
    you: Boolean(resolved(cards, "identity.ssn.title")),
    connect: Boolean(resolved(cards, "income.confirm.title")) && !pending(cards, "assets.connect.purpose"),
    details: Boolean(resolved(cards, "profile.title")),
    questions: declarations.some((c) => c.status === "resolved") && !declarations.some((c) => c.status === "pending"),
    demographics: Boolean(resolved(cards, "demographics.title")),
    review: Boolean(resolved(cards, "refi.product.choice")) || Boolean(resolved(cards, "preapproval.target")),
  };
}

/** The goal card's option the tap carries (docs/ux/18 §2.2, §2.4): buy → purchase; lower / faster → limited_cash_out; cash → cash_out. */
export function goalOptionOf(draft: Draft): "buy" | "lower_rate" | "cash_out" | null {
  if (draft.intent === "purchase") return "buy";
  if (draft.intent === "refinance") return draft.refiGoal === "cash" ? "cash_out" : "lower_rate";
  return null;
}
