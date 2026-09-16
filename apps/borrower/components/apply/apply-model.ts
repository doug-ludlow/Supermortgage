import type { AnyCardInstance } from "@/lib/types/cards";

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

export type Draft = {
  intent: Intent;
  refiGoal: RefiGoal;
  occupancy: Occupancy;
  shopping: boolean;
  property: string;
  location: string;
  price: string;
  down: string;
  value: string;
  balance: string;
  cashOut: string;
  legalName: string;
  email: string;
  dob: string;
  ssn: string;
  housing: "own" | "rent" | "free";
  months: string;
  priorAddress: string;
  income: string;
  employer: string;
  incomeType: "w2" | "self" | "other";
  citizenship: "us_citizen" | "permanent_resident" | "non_permanent_resident";
  marital: "unmarried" | "married" | "separated";
  dependents: string;
  noneApply: boolean;
  declinedDemo: boolean;
  creditOk: boolean;
  connected: boolean;
  submitted: boolean;
  result: string;
};

export const EMPTY: Draft = {
  intent: null,
  refiGoal: "lower",
  occupancy: "primary",
  shopping: false,
  property: "",
  location: "",
  price: "",
  down: "",
  value: "",
  balance: "",
  cashOut: "",
  legalName: "",
  email: "",
  dob: "",
  ssn: "",
  housing: "own",
  months: "36",
  priorAddress: "",
  income: "",
  employer: "",
  incomeType: "w2",
  citizenship: "us_citizen",
  marital: "unmarried",
  dependents: "0",
  noneApply: true,
  declinedDemo: false,
  creditOk: false,
  connected: false,
  submitted: false,
  result: "",
};

export const TASKS: { id: TaskId; label: string }[] = [
  { id: "property", label: "Your home" },
  { id: "you", label: "Credit check" },
  { id: "connect", label: "Income & assets" },
  { id: "details", label: "Your details" },
  { id: "questions", label: "Declarations" },
  { id: "demographics", label: "Demographics" },
  { id: "review", label: "Review & submit" },
];

export function cents(raw: string): string {
  const n = Number(String(raw).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n * 100));
}

export function pending(cards: AnyCardInstance[], key: string) {
  return cards.find(
    (c) => c.status === "pending" && (c.copy_key === key || c.copy_key.startsWith(key)),
  );
}
