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
  housing: "own" | "rent" | "free";
  rent: string;
  months: string;
  priorAddressLine: string;
  priorCity: string;
  priorState: string;
  priorZip: string;
  priorBasis: "own" | "rent" | "free";
  priorMonths: string;
  income: string;
  employer: string;
  citizenship: "us_citizen" | "permanent_resident" | "non_permanent_resident";
  marital: "unmarried" | "married" | "separated";
  dependents: string;
  military: string;
  language: string;
  noneApply: boolean;
  declinedDemo: boolean;
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
  priorMonths: "",
  income: "",
  employer: "",
  citizenship: "us_citizen",
  marital: "unmarried",
  dependents: "0",
  military: "",
  language: "",
  noneApply: true,
  declinedDemo: false,
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
  "income.connect.purpose": "connect",
  "income.confirm.title": "connect",
  "assets.connect.purpose": "connect",
  "profile.title": "details",
  "demographics.title": "demographics",
  "refi.value.confirm": "review",
  "refi.loan_amount.confirm": "review",
  "refi.product.choice": "review",
  "preapproval.target": "review",
};
export function stepOfCopyKey(copyKey: string): Step | undefined {
  if (copyKey.startsWith("declarations.")) return "questions";
  return STEP_OF_COPY_KEY[copyKey];
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
  const declarations = cards.filter((c) => c.copy_key.startsWith("declarations."));
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
