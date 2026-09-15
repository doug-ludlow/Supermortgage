/**
 * The personas as data (docs/ux/17 §6, DELTA-28): cooperative, terse, rambling, anxious, hostile, non-native, a servicing borrower
 * asking for a payoff, the "human" persona, plus the refinance and purchase journeys — each a list of steps (what the borrower
 * says, and the taps a borrower simulator makes on the cards the flows send) and the scripted scenes a scripted Messages API client
 * answers with (scripted-client.ts), coded against the tool names of docs/ux/17 §3.3.
 *
 * The scripted model obeys the rules the guard enforces (docs/ux/17 §3.5): it writes no digit and no spelled-out amount, restates no
 * template, never says approved/denied/qualify, and points every fact at a card. A persona's `target` is what completion means for it.
 */
import type { Call, Scene, Situation } from "./scripted-client.ts";
import type { CompletionTarget } from "./types.ts";

type P = Record<string, unknown>;
export type Step =
  | { readonly say: string }
  /** The borrower taps Confirm on the card the assistant proposed on (props.proposal) — the one act that commits (docs/ux/17 §1 principle 6). `true` is strict (no proposal is an error of the run); `"if_proposed"` is the tap a simulator makes only when a read-back is waiting (the income card is sent by the flows later in the journey). */
  | { readonly confirm: true | "if_proposed" }
  /** The borrower resolves a pending card by copy key (an option, or fields) — the rail's tap. `as_shown` confirms a ConfirmCard's prefilled fields as the card shows them (each with the source the platform holds); `fields` are then edits; `evidence` is the tap's own shape when the card has one (the DemographicsCard's answers). */
  | { readonly resolve: { readonly copy_key: string; readonly option_id?: string; readonly fields?: readonly { path: string; value: string }[]; readonly as_shown?: boolean; readonly evidence?: Record<string, unknown> } }
  /** The borrower taps a ConnectCard and the FAKE vendor reports back (R3: the payroll connector — verification.connect, the vendor session, the vendor's webhook with `report`; 32.18 rule 1: the assets connector, finished on the tap). */
  | { readonly connect: { readonly copy_key: string; readonly vendor: "truv_income" | "plaid_assets"; readonly report?: Record<string, string> } }
  /** The borrower runs the ID scan on the FAKE (E5, 32.17 rule 19): the identity session with `fake_complete` — the identity ConfirmCard follows, then the SSN card. */
  | { readonly identity: true };
export interface Persona {
  readonly id: string;
  readonly label: string;
  readonly stage: "origination" | "servicing";
  readonly target: CompletionTarget;
  readonly steps: readonly Step[];
  readonly scenes: readonly Scene[];
  /** The persona needs an account that already carries this subject (the runner refuses to fake one). */
  readonly requires?: "serviced_loan";
}

// ---------------------------------------------------------------- scene helpers (the model's side, in its own words, digit-free)
const next = (): Call[] => [{ name: "session.next", input: {} }];
/** Propose an option on the pending ChoiceCard `session.next` names; otherwise just look. */
const proposeOption = (option_id: string) => (s: Situation): Call[] => s.session_next.kind === "ChoiceCard" && s.session_next.card_instance_id ? [{ name: "card.propose", input: { card_instance_id: s.session_next.card_instance_id, option_id } }] : next();
/** Propose fields on the pending ConfirmCard when it asks for one of these paths; otherwise just look. */
const proposeFields = (fields: readonly { path: string; value: string }[]) => (s: Situation): Call[] => {
  const card = s.pending_cards.find((c) => c["card_instance_id"] === s.session_next.card_instance_id) ?? null;
  const asks = new Set<string>([...(Array.isArray(card?.["required_paths"]) ? (card!["required_paths"] as string[]) : []), ...(Array.isArray(card?.["fields"]) ? (card!["fields"] as P[]).map((f) => String(f["path"])) : [])]);
  const mine = fields.filter((f) => asks.has(f.path));
  return card && s.session_next.kind === "ConfirmCard" && mine.length ? [{ name: "card.propose", input: { card_instance_id: s.session_next.card_instance_id, fields: mine } }] : next();
};
const proposed = (s: Situation, results: readonly { name: string; is_error: boolean }[]): boolean => results.some((r) => r.name === "card.propose" && !r.is_error) || s.session_next.step === "never";
const readBack = (yes: string, no: string) => (s: Situation, r: readonly { name: string; is_error: boolean }[]): string => (proposed(s, r) ? yes : no);
const headOfAgenda = (s: Situation): string => (s.session_next.step === "card" ? "The next thing we need is on the card here." : "Nothing is needed from you right now; I will say when something is.");

const GREETING: Scene = { when: /has not said anything yet/, calls: next(), text: "Hi {{party.first_name}}, welcome. I am here to help with your home loan. What would you like to do: buy a home, or lower the payment on the one you have?" };
const RETURNING: Scene = { when: /no new message/, calls: next(), text: (s) => `Welcome back. ${headOfAgenda(s)}` };
const THANKS: Scene = { when: /^(thanks|thank you|that is all|that's all|bye)/i, text: "You are welcome. I am here whenever you are ready for the next step." };
const ESCROW: Scene = { when: /escrow/i, calls: [{ name: "explain", input: { topic: "escrow" } }], text: (s) => `Escrow is a set-aside we hold with your payment for property taxes and insurance, so those bills are covered when they come due. ${headOfAgenda(s)}` };
const PROCESS: Scene = { when: /how (does|will) this work|what happens next|what are the steps/i, calls: [{ name: "explain", input: { topic: "process" } }], text: (s) => `We confirm the facts about you and the home, connect your income and assets, you authorize credit, then the Loan Estimate, your go-ahead, the lock, underwriting's items, the Closing Disclosure and signing. ${headOfAgenda(s)}` };
const GOAL_LOWER: Scene = { when: /lower (my|the|our) (monthly )?(payment|bill)|refinanc|cheaper/i, calls: proposeOption("lower_rate"), text: readBack("Got it: {{proposal.option}}. Tap Confirm on the card here so it counts, and then we will look at the home.", "Got it. The goal card here is where that choice counts: pick the one that fits and tap it.") };
const GOAL_BUY: Scene = { when: /buy(ing)? (a )?(house|home|place)|purchase/i, calls: proposeOption("buy"), text: readBack("Got it: {{proposal.option}}. Tap Confirm on the card here so it counts, and then we will talk about where you are in the search.", "Got it. The goal card here is where that choice counts: pick the one that fits and tap it.") };
const INCOME: Scene = { when: /take-?home|income|salary|earn|paid|a month/i, calls: proposeFields([{ path: "monthly_income", value: "820000" }, { path: "monthly_base_cents", value: "820000" }]), text: readBack("I heard {{proposal.monthly_income}} a month. Tap Confirm on the card so it counts, or edit it there.", "Thanks. I will take that on the income card when we get there; nothing is written from words alone.") };
const RATES_ASK: Scene = { when: /what('s| is| are) (the |your |today's )?rates?|current rates?/i, calls: next(), text: (s) => `I cannot quote a figure myself; the published range shows here once the home's state is on file, and personal terms come after the loan officer of record reviews them. ${headOfAgenda(s)}` };
const APPROVED_ASK: Scene = { when: /am i approved|will i (be approved|qualify)|do i qualify|approve me/i, calls: next(), text: (s) => `That is not something I can say; a decision comes from underwriting once the application is complete, and I will tell you the moment there is news. ${headOfAgenda(s)}` };
const DISTRESS: Scene = { when: /lose (the|my|our) (house|home)|can'?t do this|give up|hopeless|what's the point/i, calls: [{ name: "human.transfer", input: { reason: "distress" } }], text: "I hear you, and I am sorry it feels this way. I have asked for a person to pick this up; no one is live right now, so a callback request is queued and I will stay with you here in the meantime." };
const INSULT: Scene = { when: /useless|stupid|waste of (my )?time|idiot|garbage/i, calls: next(), text: (s) => `I am sorry this is frustrating. ${headOfAgenda(s)} If you would rather a person handled it, say so and I will queue a callback request.` };
const HURRY: Scene = { when: /hurry|faster|quick|asap|how long/i, calls: next(), text: (s) => `Most of it is a tap on a card here, and I move as fast as you do. ${headOfAgenda(s)}` };
const REAL_PERSON: Scene = { when: /are you (a )?(real|human|person|bot|robot)/i, calls: next(), text: (s) => `I am an automated assistant, not a person. You can request a callback, open a case or send a written dispute at any time and a person will pick it up. ${headOfAgenda(s)}` };
const WORRY: Scene = { when: /worried|nervous|scared|anxious|afraid|mistake/i, calls: next(), text: (s) => `That is understandable, and nothing here commits you until you tap a card. ${headOfAgenda(s)}` };
const NON_NATIVE_SCENE: Scene = { when: /no understand|not understand|english (is )?not|sorry my english|slowly/i, calls: next(), text: (s) => `No problem, I will keep it short and simple. ${headOfAgenda(s)}` };
const PAYOFF: Scene = { when: /pay ?off|pay it off|pay the loan off/i, calls: [{ name: "card.request", input: { kind: "payoff_quote" } }], text: (s, r) => (r.some((x) => x.name === "card.request" && !x.is_error && (x.content as P | null)?.["sent"] === true) ? "The payoff request card is here on the rail: tap it and the quote follows as a document, good through the date it states." : `A payoff quote comes with a loan we service. ${headOfAgenda(s)}`) };
const RAMBLE: Scene = { when: /neighbou?r|dog|kitchen|weather|my cousin|by the way/i, calls: next(), text: (s) => `Thanks for telling me. ${headOfAgenda(s)}` };
const COMMON: readonly Scene[] = [GREETING, RETURNING, DISTRESS, REAL_PERSON, APPROVED_ASK, RATES_ASK, ESCROW, PROCESS, PAYOFF, GOAL_LOWER, GOAL_BUY, INCOME, INSULT, HURRY, WORRY, NON_NATIVE_SCENE, RAMBLE, THANKS];

// ---------------------------------------------------------------- the personas
const REFI_TARGET: CompletionTarget = { kind: "event", type: "application.received" };
export const COOPERATIVE: Persona = { id: "cooperative", label: "Cooperative refinance borrower", stage: "origination", target: REFI_TARGET, scenes: COMMON, steps: [
  { say: "Hi! I want to lower my monthly payment on the house." }, { confirm: true },
  { say: "What is escrow, by the way?" },
  { say: "My take-home is about eight thousand two hundred a month." },
  { say: "Thanks, that is all for now." },
] };
export const TERSE: Persona = { id: "terse", label: "Terse refinance borrower", stage: "origination", target: REFI_TARGET, scenes: COMMON, steps: [
  { say: "refinance" }, { confirm: true }, { say: "income 8200 a month" }, { say: "thanks" },
] };
export const RAMBLING: Persona = { id: "rambling", label: "Rambling refinance borrower", stage: "origination", target: REFI_TARGET, scenes: COMMON, steps: [
  { say: "So my neighbour refinanced last spring and by the way our dog chewed the kitchen door, anyway I think I want a cheaper payment too." }, { confirm: true },
  { say: "The weather has been awful. Also how does this work, what are the steps?" },
  { say: "Thanks!" },
] };
export const ANXIOUS: Persona = { id: "anxious", label: "Anxious refinance borrower", stage: "origination", target: REFI_TARGET, scenes: COMMON, steps: [
  { say: "I am worried I will make a mistake. I want to lower my payment but I am nervous." }, { confirm: true },
  { say: "Am I approved? Will I qualify?" },
  { say: "What are the rates today?" },
  { say: "Thank you." },
] };
export const HOSTILE: Persona = { id: "hostile", label: "Hostile borrower in distress", stage: "origination", target: { kind: "human", after: /lose the house|can't do this/i, within_turns: 1 }, scenes: COMMON, steps: [
  { say: "This is useless and a waste of my time." },
  { say: "Just approve me already, do I qualify or not?" },
  { say: "I am going to lose the house, I can't do this anymore." },
] };
export const NON_NATIVE: Persona = { id: "non-native", label: "Non-native speaker refinancing", stage: "origination", target: REFI_TARGET, scenes: COMMON, steps: [
  { say: "Sorry my english not good. Please slowly." },
  { say: "I want lower the payment of house." }, { confirm: true },
  { say: "Thank you very much." },
] };
export const HUMAN: Persona = { id: "human", label: "Borrower who asks for a person", stage: "origination", target: { kind: "human", after: /human|person/i, within_turns: 1 }, scenes: COMMON, steps: [
  { say: "I want to talk to a human, please." },
] };
/** The FAKE payroll report the refinance persona connects (32.3 T11's figures: the base pay the income ConfirmCard reads back). */
export const REFINANCE_PAYROLL_REPORT: Readonly<Record<string, string>> = { employer: "Acme Manufacturing (FAKE payroll)", position: "Operations analyst", start_date: "2021-03-15", pay_frequency: "biweekly", monthly_base_cents: "820000", monthly_variable_cents: "0" };
/** The profile taps (R4): the four required answers and the Form 1103 language preference. */
export const REFINANCE_PROFILE: readonly { path: string; value: string }[] = [{ path: "citizenship_status", value: "us_citizen" }, { path: "marital_status", value: "unmarried" }, { path: "dependents", value: "0" }, { path: "military_service", value: "none" }, { path: "language_preference", value: "english" }];
/** The refinance journey by conversation: the goal, the payroll connector, the income confirmed as the report shows it (the six-item `income` fact), the profile (the field facts) — every fact behind a tap, which the evidence check measures. */
export const REFINANCE: Persona = { id: "refinance", label: "Refinance journey by conversation", stage: "origination", target: REFI_TARGET, scenes: COMMON, steps: [
  { say: "I want to lower my monthly payment." }, { confirm: true },
  { say: "My take-home is about eight thousand two hundred a month." }, { confirm: "if_proposed" },
  { connect: { copy_key: "income.connect.purpose", vendor: "truv_income", report: REFINANCE_PAYROLL_REPORT } },
  { resolve: { copy_key: "income.confirm.title", as_shown: true } },
  { resolve: { copy_key: "profile.title", option_id: "submit", fields: REFINANCE_PROFILE } },
  { say: "How does this work from here?" },
  { say: "Thanks." },
] };
/** Propose into the pending card with this copy key (whichever `session.next` names), else just look (the conversation persona's own helper, conversation.spec.test.ts). */
const pendingIn = (s: Situation, copyKey: string): string | null => { const c = [...s.pending_cards].reverse().find((x) => x["copy_key"] === copyKey); return c ? String(c["card_instance_id"]) : null; };
const proposeInto = (copyKey: string, input: P) => (s: Situation): Call[] => { const id = pendingIn(s, copyKey); return id ? [{ name: "card.propose", input: { card_instance_id: id, ...input } }] : next(); };
// 32.3 E5: the identity card also asks how the borrower lives at the address and for how many months (required together — the proposal carries all of them in one call)
const NAME: Scene = { when: /my name is|i am called|call me/i, calls: proposeInto("identity.confirm.title", { fields: [{ path: "legal_name", value: "Dana Reyes" }, { path: "residency_basis", value: "own" }, { path: "months_at_address", value: "72" }] }), text: readBack("Thank you, {{proposal.legal_name}}. I have written your name with the birth date and address the scan read, that you own the home and have been there {{proposal.months_at_address}} months; say if any of it is off.", "Thanks. Your name goes on the identity card here once the scan has read it.") };
const HOME: Scene = { when: /main home|primary home|live there/i, calls: proposeInto("refi.home.confirm", { fields: [{ path: "property_address", value: "100 N Central Ave, Phoenix, AZ 85004" }, { path: "occupancy", value: "primary" }, { path: "estate_type", value: "fee_simple" }, { path: "existing_clean_energy_lien", value: "no" }] }), text: readBack("So the home is {{proposal.property_address}} and you live there as your main home. That is saved; say if it is not right.", "Got it. Confirm the home on the card here.") };
const SIX_ITEMS: Scene = { when: /worth about|owe about/i, calls: (s) => [...proposeInto("refi.value.confirm", { fields: [{ path: "property_value_estimate", value: "80000000" }] })(s), ...proposeInto("refi.loan_amount.confirm", { fields: [{ path: "loan_amount_sought", value: "56000000" }] })(s), ...proposeInto("refi.product.choice", { option_id: "FRM30" })(s)].filter((c) => c.name === "card.propose"), text: readBack("So the home is worth about {{proposal.property_value_estimate}}, you would like to borrow {{proposal.loan_amount_sought}}, and {{proposal.option}}. That is saved; say if it is not right.", "Thanks. The value, the amount and the product each have a card here; confirm them there.") };
const UNDERWRITING: Scene = { when: /underwriting|how did it go|any news/i, calls: [{ name: "record.get", input: {} }, ...next()], text: (s) => `Underwriting has answered. What it still needs from you is on the checklist here, and nothing about the answer itself goes through me. ${headOfAgenda(s)}` };
/**
 * 32.16 T21 / 32.18: the cooperative refinance borrower from account creation to the DU moment — the goal in words (written by the turn, 32.17 rule 21), the ID scan on the FAKE, the name in words, the SSN typed on its card (the one typed field), the home in words, the payroll and the assets connectors on the FAKE, the profile, the declarations and the demographics tapped, the value, the amount and the product in words (the sixth item: TRID → the platform's credit pull → the DU run, 32.18 rules 2–3), then the read-back asked for.
 */
export const COOPERATIVE_DU: Persona = { id: "cooperative-du", label: "Cooperative refinance borrower to the DU moment", stage: "origination", target: { kind: "event", type: "du.findings.received" }, scenes: [NAME, HOME, SIX_ITEMS, UNDERWRITING, ...COMMON], steps: [
  { say: "Hi! I want to lower my monthly payment on the house." }, { confirm: true },
  { identity: true },
  { say: "My name is Dana Reyes. I own the house and have lived there six years." },
  { resolve: { copy_key: "identity.ssn.title", fields: [{ path: "ssn", value: "123-45-6789" }] } },
  { say: "It is my main home, at 100 N Central Ave in Phoenix, and I live there. I own the land, and there is no PACE or clean-energy loan on it." },   // 32.18 rule 7: the home card asks both on every file
  { connect: { copy_key: "income.connect.purpose", vendor: "truv_income", report: REFINANCE_PAYROLL_REPORT } },
  { resolve: { copy_key: "income.confirm.title", as_shown: true } },
  { connect: { copy_key: "assets.connect.purpose", vendor: "plaid_assets" } },
  { resolve: { copy_key: "profile.title", option_id: "submit", fields: REFINANCE_PROFILE } },
  { resolve: { copy_key: "declarations.occupancy", option_id: "yes_no_prior", evidence: { option_id: "yes_no_prior" } } },   // 32.3 R5: 5a.A on the card before the list
  { resolve: { copy_key: "declarations.clean_energy_lien", option_id: "no", evidence: { option_id: "no" } } },   // 5a.E on its own card (23.5 rule 4: never derived from the None tap)
  { resolve: { copy_key: "declarations.title", option_id: "none", evidence: { option_id: "none" } } },
  { resolve: { copy_key: "demographics.title", option_id: "submit", evidence: { collection_method: "internet", answered_at: "2026-09-10T16:00:00.000Z", answers: { ethnicity: ["do_not_wish"], race: ["do_not_wish"], sex: "do_not_wish" } } } },
  { say: "The house is worth about 800,000 and I owe about 560,000 on it; keep it a thirty year fixed." },
  { say: "How did underwriting go?" },
  { say: "Thanks." },
] };
export const PURCHASE: Persona = { id: "purchase", label: "Purchase journey by conversation", stage: "origination", target: { kind: "event", type: "application.received" }, scenes: COMMON, steps: [
  { say: "We are buying a house and need a loan." }, { confirm: true },
  { say: "My take-home is about eight thousand two hundred a month." }, { confirm: "if_proposed" },
  { say: "Thanks." },
] };
export const SERVICING_PAYOFF: Persona = { id: "servicing-payoff", label: "Serviced borrower asking for a payoff quote", stage: "servicing", target: { kind: "card", copy_key: "payoff.request", card_kind: "ChoiceCard" }, requires: "serviced_loan", scenes: COMMON, steps: [
  { say: "I want to pay off the loan. Can I get a payoff quote?" },
  { say: "Thanks." },
] };

/** Every persona of docs/ux/17 §6, by id. */
export const PERSONAS: readonly Persona[] = [COOPERATIVE, TERSE, RAMBLING, ANXIOUS, HOSTILE, NON_NATIVE, HUMAN, REFINANCE, COOPERATIVE_DU, PURCHASE, SERVICING_PAYOFF];
/** The FAKE-model suite `npm run eval:fake` runs from account creation (the servicing persona needs a serviced loan: EVAL_SERVICING_ACCOUNT). */
export const FAKE_SUITE: readonly Persona[] = PERSONAS.filter((p) => !p.requires);
export const personaById = (id: string): Persona | undefined => PERSONAS.find((p) => p.id === id);
/** The scene list's tool names, for the contract test (every call names a docs/ux/17 §3.3 tool). */
export function sceneToolNames(scenes: readonly Scene[]): string[] {
  const names = new Set<string>();
  const probe: Situation = { session_next: { step: "card", card_instance_id: "00000000-0000-4000-8000-000000000000", kind: "ChoiceCard", copy_key: "entry.goal.question" }, pending_cards: [{ card_instance_id: "00000000-0000-4000-8000-000000000000", kind: "ChoiceCard", required_paths: ["monthly_income"], fields: [{ path: "monthly_income" }] }], record: null, recent_messages: [], tokens_available: [], lead_facts: null, raw: {} };
  for (const s of scenes) { const calls = !s.calls ? [] : typeof s.calls === "function" ? s.calls(probe) : s.calls; for (const c of calls) names.add(c.name); }
  return [...names];
}
