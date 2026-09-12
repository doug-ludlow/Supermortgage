/**
 * §32.16 process-owned tools — the agent turn's tool contract (docs/ux/17 §3.3, DELTA-24) as bus tools of the thread-owning
 * agents (`intake` before funding, `borrower-comms` after — spec/registry/agents.json names the nine on both), defined with
 * `defineTools("32.16", "intake", defs)` and spread by ./index.ts. Every call the model makes is one of these, executed on the bus
 * by src/runtime/borrower/agent/tools.ts with the API's facts on the input (`party_id`, `subject`, `session_id`, `conversation_id`,
 * `message_id`, `channel`, `assurance_level` — never the model's) and an agent_decisions row each; the model-facing schema
 * (`MODEL_TOOLS_32_16`) is generated from these definitions at boot.
 *
 *   session.next        the pending card with the highest priority — the record's current ask first, then a gate-blocked card, then
 *                       the rest oldest first — as {step, card_instance_id, kind, copy_key, why_copy_key, allowed_answers,
 *                       disallowed_topics, blocking_reason}, or {step: idle, waiting_on: what_we_are_doing[]}
 *   record.get          the compact borrower_record (agent/context.ts `compactRecord`): numbers, dates, names as `{{token}}`s
 *   explain             a bounded topic list in plain words (SAFE `general_explanation`), 20.3 explainProgram for `program`, and
 *                       `rates` — 20.3's published range through 20.2's checklist (32.14 lead.requestRange): the API renders it as
 *                       the rates element beside the reply; the model never sees a figure it may restate. On a serviced loan the
 *                       servicing topics (SERVICING_EXPLAIN_TOPICS: balance, payment_applied, escrow, escrow_analysis, escrow_shortage,
 *                       late_charge, payoff, autopay, hardship, rate_watch, statements) answer from the record and the 02 §1.5 history
 *                       views as `{{token}}`s (agent/servicing-context.ts) — never a computed date or figure; payoff hands back no figure
 *   timer.due           an allow-listed timer's due date as a token (record.ts ALLOWED_TIMER_CODES / the flows' rows)
 *   document.describe   class, status, one line — never contents
 *   card.propose        the proposal-and-confirm loop (§3.4): validated against the card's paths / money_paths / options and 21.1
 *                       validateUlad, written to card_instances.props.proposal; resolves nothing; a re-proposal counts a miss
 *   card.request        a card the borrower may ask for in words (CARD_REQUESTS: a one-time payment, extra principal, autopay enroll /
 *                       change / pause / revoke, a payoff quote, the escrow shortage choice, a hardship intake, an upload, a callback,
 *                       a notice of error, a statement copy, e-delivery consent) — each the owning flow's own card, built by that flow's
 *                       exported builder from the loan's rows inside this unit of work, through 32.1 send_card on the subject; or the
 *                       card already on the rail; or the reason it is not available. Money commands and consents never resolve here:
 *                       the card appears and the tap resolves it.
 *   command.run         the borrower-initiated non-money, non-consent commands only (COMMAND_RUN_ALLOWLIST) — anything else is
 *                       refused by the bus (`command.refused`) before anything runs
 *   human.transfer      32.2 human.request (the queue a person — or the FAKE reviewer — answers)
 *
 * Refused by construction: any money command, any consent, any resolveCard — none is reachable from here.
 */
import { createHash, randomUUID } from "node:crypto";
import { defineTools, compute, never, str, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { isUuid, toJson } from "../../infra/db/client.ts";
import { PgBorrowerUiRepository, type CardInstanceRow } from "../../infra/db/borrower-ui.ts";
import { PgBorrowerPartyRepository, type PartyRow, type Subject } from "../../infra/db/borrower-parties.ts";
import { BorrowerRecordReader, timerAllowed, timerLabel, type BorrowerRecord } from "../../runtime/borrower/record.ts";
import { copyText } from "../../runtime/borrower/channels.ts";
import { compactRecord, type SessionNext } from "../../runtime/borrower/agent/context.ts";
import { servicingView, historyView, termsView, usd, type HistoryView } from "../../runtime/borrower/agent/servicing-context.ts";
import { paymentFacts, paymentCard, extraPrincipalCard, autopayEnrollCard, autopayChoiceCard, escrowShortageCard, openShortage, SERVICING_ESIGN_SCOPES, type PaymentFacts, type CardSpec } from "../../runtime/borrower/flows/8-servicing-payments.ts";
import { paidThrough } from "../../runtime/borrower/flows/9-servicing-requests.ts";
import { plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import { validateUlad, ULAD_ENUMS } from "../../domain/application/ops-21-1.ts";
import { explainProgram } from "../../domain/leads-pricing/ops-20-3.ts";
import { delegate } from "./section32-2.ts";

export const PROCESS_32_16 = "32.16";
export const INTAKE = "intake";
type P = Record<string, unknown>;

/** §3.3: the borrower-initiated non-money, non-consent commands `command.run` may issue — nothing else reaches the bus from a turn. */
export const COMMAND_RUN_ALLOWLIST: readonly string[] = ["human.request", "refi.request", "case.open", "callback.schedule", "preference.set", "contact.log", "dispute.intake", "promise.record"];
/** Where each allow-listed command lives (the owning process's tool; delegate() runs it as that agent, nested in this unit of work). */
const COMMAND_PROCESS: Readonly<Record<string, string>> = { "human.request": "32.2", "refi.request": "32.2", "case.open": "32.2", "callback.schedule": "4.3", "preference.set": "11.3", "contact.log": "11.3", "dispute.intake": "11.3", "promise.record": "11.3" };
/** Card kinds a proposal may go into (evidence the borrower states or confirms — §2.3); consents, demographics and payments never take words. */
export const PROPOSABLE_KINDS: ReadonlySet<string> = new Set(["ConfirmCard", "ChoiceCard", "ProfileCard"]);
/** Commands whose card is never answered in words whatever its kind (docs/ux/17 §1 principle 6, §2.3 consent; 32.3 R5/R6): the consents, the credit authorization, the declarations and demographics, money and the closing/rescission elections — a proposal into their card is refused (CARD_PROPOSE_NEVER_IN_WORDS). */
export const NEVER_PROPOSE_COMMANDS: ReadonlySet<string> = new Set(["consent.capture", "credit.authorize", "application.answerDeclarations", "application.answerDemographics", "payment.makeOneTime", "payment.extraPrincipal", "autodraft.enroll", "autodraft.change", "autodraft.pause", "autodraft.revoke", "closing.captureEsignConsent", "rescission.exercise", "escrow.electShortage"]);
/** docs/ux/17 §3.7: the third miss on a card transfers to a human. */
export const MISSES_TO_HUMAN = 3;

/** A refusal these tools name themselves (the bus lets a *Refused through; the turn reads it back to the model as a tool error). */
export class AgentToolRefused extends Error { readonly code: string; readonly copy_key: string | undefined; constructor(code: string, message: string, copy_key?: string) { super(`${code}: ${message}`); this.name = "AgentToolRefused"; this.code = code; this.copy_key = copy_key; } }

// ---------------------------------------------------------------- helpers
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const obj = (i: ToolInput, k: string): P => ((i[k] && typeof i[k] === "object" && !Array.isArray(i[k]) ? (i[k] as P) : {}));
const dbOf = (rt: ToolRuntime): Queryable => { const db = rt.services["db"] as Queryable | undefined; if (!db) throw new PortUnavailable("service:db"); return db; };
const defer = (rt: ToolRuntime, fn: (q: Queryable) => Promise<void>): void => { const d = rt.services["deferWrite"] as ((fn: (q: Queryable) => Promise<void>) => void) | undefined; if (!d) throw new PortUnavailable("service:deferWrite"); d(fn); };
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const short = (id: string): string => id.replace(/-/g, "").slice(0, 8);

interface Situation { readonly party: PartyRow; readonly subject: Subject | null; readonly cards: CardInstanceRow[]; readonly record: BorrowerRecord | null }
/** The party, its subject (the input's, else its first), its cards and its record — the API's facts, read from the tables the read models own. */
async function situationOf(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<Situation> {
  need(i, "party_id"); const party_id = str(i, "party_id"); if (!isUuid(party_id)) throw new RangeError("party_id must be the party's uuid");
  const db = dbOf(rt); const parties = new PgBorrowerPartyRepository(db); const ui = new PgBorrowerUiRepository(db);
  const party = await parties.get(party_id); if (!party) throw new RangeError(`no party ${party_id}`);
  const subjects = await parties.subjectsOf(party_id); const wanted = obj(i, "subject");
  const subject = subjects.find((s) => (wanted["application_id"] && s.application_id === wanted["application_id"]) || (wanted["loan_id"] && s.loan_id === wanted["loan_id"])) ?? subjects[0] ?? null;
  const cards = await ui.cardsOf(party_id);
  const record = subject ? await new BorrowerRecordReader(db).record(party, subject, cards, ctx.now) : null;
  return { party, subject, cards, record };
}
const DISALLOWED_BASE = ["a personal rate, APR or payment before the loan officer of record's review", "whether the borrower qualifies, is approved or is eligible", "credit report contents, scores, DU findings, fraud or QC"];
const NEVER_IN_WORDS: Readonly<Record<string, string>> = { ConsentCard: "the consent itself — it is taken on the card only, never in words", DemographicsCard: "the demographic answers — the card only, nothing inferred", PaymentCard: "the payment details — the card, with a fresh code" };
/** The answers the model may propose for the card: option ids for a choice, the paths (with their kind) for a confirm/profile card. */
function answersOf(c: CardInstanceRow): P[] {
  const props = c.props;
  if (c.kind === "ChoiceCard") return (Array.isArray(props["options"]) ? (props["options"] as P[]) : []).map((o) => ({ option_id: o["id"], label: o["label"] }));
  if (c.kind === "ConfirmCard" || c.kind === "ProfileCard") {
    const money = new Set(Array.isArray(props["money_paths"]) ? (props["money_paths"] as string[]) : []);
    return (Array.isArray(props["fields"]) ? (props["fields"] as P[]) : []).map((f) => { const path = String(f["path"] ?? ""); return { path, label: f["label"] ?? path, kind: money.has(path) || /_cents$/.test(path) ? "money_cents" : Array.isArray(f["options"]) ? "choice" : f["input"] === "number" ? "number" : "text", ...(Array.isArray(f["options"]) ? { options: (f["options"] as P[]).map((o) => o["id"]) } : {}) }; });
  }
  return [];
}
/** docs/ux/17 §3.3 `session.next`: the current ask first (the record's needed_from_you order), then a gate-blocked card, then the rest oldest first; idle otherwise. */
export function sessionNextOf(record: BorrowerRecord | null, cards: readonly CardInstanceRow[]): SessionNext {
  const pending = cards.filter((c) => c.status === "pending"); const byId = new Map(pending.map((c) => [c.card_instance_id, c] as const));
  const ordered: CardInstanceRow[] = [];
  for (const n of record?.needed_from_you ?? []) { const c = n.card_instance_id ? byId.get(n.card_instance_id) : undefined; if (c && !ordered.includes(c)) ordered.push(c); }
  const rest = pending.filter((c) => !ordered.includes(c)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const blockers = rest.filter((c) => typeof c.props["gate"] === "string" && /DU|READINESS|GATE/i.test(String(c.props["gate"])));
  const head = ordered[0] ?? blockers[0] ?? rest[0];
  if (!head) return { step: "idle", card_instance_id: null, kind: null, copy_key: null, why_copy_key: null, allowed_answers: [], disallowed_topics: DISALLOWED_BASE, blocking_reason: null, waiting_on: (record?.what_we_are_doing ?? []).map((d) => ({ label: d.label, owner: d.owner, status: d.status })) };
  const why = (head.props["helper_copy_key"] ?? head.props["why_copy_key"] ?? head.props["intro_copy_key"] ?? null) as string | null;
  return { step: "card", card_instance_id: head.card_instance_id, kind: head.kind, copy_key: head.copy_key, why_copy_key: why, allowed_answers: answersOf(head), disallowed_topics: [...DISALLOWED_BASE, ...(NEVER_IN_WORDS[head.kind] ? [NEVER_IN_WORDS[head.kind]!] : [])], blocking_reason: typeof head.props["gate"] === "string" ? String(head.props["gate"]) : null, waiting_on: [] };
}

// ---------------------------------------------------------------- explain: the bounded topic list (plain words, no figures — SAFE general_explanation)
export const EXPLAIN_TOPICS: Readonly<Record<string, string>> = {
  escrow: "Escrow is a set-aside we hold with your mortgage payment to pay your property taxes and homeowner's insurance when they come due, so you don't face those bills all at once. Each month a share of your payment goes into it; once a year we review it and adjust if taxes or insurance changed.",
  apr: "The APR is the yearly cost of the loan including the interest rate and most lender fees, shown as one percentage so loans can be compared. It is usually a little higher than the rate itself.",
  points: "Points are an upfront fee paid at closing to lower the interest rate. Paying points costs more now and less each month; whether it is worth it depends on how long you keep the loan.",
  rate_lock: "A rate lock holds an interest rate for a set number of days while your loan is finished. If rates rise during that time yours stays put; if the lock runs out before closing it may need an extension.",
  loan_estimate: "The Loan Estimate is the standard three-page form every lender uses to show a loan's terms, monthly payment, closing costs and cash to close. It is an estimate, not a commitment, and it lets you compare offers side by side.",
  closing_disclosure: "The Closing Disclosure is the final five-page form with your loan's actual terms and costs. You receive it at least three business days before closing so you can check it against the Loan Estimate.",
  pmi: "Mortgage insurance protects the lender when the down payment or equity is below a certain share of the home's value. It is part of the monthly payment and can end once enough equity is built.",
  dti: "The debt-to-income ratio compares your monthly debt payments with your monthly income. Lenders use it to judge how comfortably a payment fits your budget.",
  appraisal: "An appraisal is an independent opinion of what the home is worth, ordered during the loan. Some loans use an automated value or a property inspection instead of a full appraisal.",
  title: "Title work checks that the home can be sold or refinanced without other claims on it, and title insurance protects against problems that were missed. A title company or attorney handles it.",
  underwriting: "Underwriting is the review of your application, income, assets, credit and the home against the loan program's rules. It ends in a decision and, often, a short list of items to finish.",
  soft_pull: "A soft credit check lets us see your credit without affecting your score. It is enough to show you the rate you would likely get; a hard check happens later, with your written authorization, when the loan is submitted.",
  hard_pull: "A hard credit inquiry is the full credit report the loan needs. It is pulled only with your typed authorization and can lower your score by a small amount for a short time.",
  esign: "E-delivery means your disclosures and notices arrive here electronically instead of by mail. It needs your consent on the card, and you can withdraw it later.",
  autopay: "Autopay drafts your payment from your bank account on a day you choose each month, so nothing is late. You can change or stop it any time; changes need a fresh sign-in code.",
  payoff: "A payoff quote is the exact amount, good through a stated date, that pays the loan in full — the balance plus interest through that date, less anything held for you.",
  forbearance: "Forbearance pauses or lowers payments for a while during a hardship. The paused amount is not forgiven; how it is caught up is settled when the pause ends.",
  rescission: "On most refinances of your own home you have three business days after signing to cancel the loan for any reason. The money is not sent until that window closes.",
  refinance: "A refinance replaces your current mortgage with a new one, usually to lower the rate or payment, change the term, or take cash out of the home's equity.",
  cash_out: "A cash-out refinance replaces your mortgage with a larger one and pays you the difference in cash, up to a limit set by the home's value.",
  preapproval: "A preapproval is a letter saying how much you could borrow based on a review of your credit, income and assets. Sellers take an offer with one more seriously; it is not a final approval.",
  process: "The steps are: confirm the facts about you and the home, connect or provide income and assets, authorize credit, receive the Loan Estimate, tell us you want to proceed, lock the rate, finish underwriting's items, review the Closing Disclosure, then sign. Most of it is a tap on a card here.",
};
/** What `explain` answers with `topic: "rates"` when the range cannot be shown (no state yet, a closed state, a failed checklist). */
export const RATES_UNAVAILABLE = "RATES_UNAVAILABLE";

// ---------------------------------------------------------------- explain: the servicing topics (32.16 Stage 4) — data: topic → the record fields it reads (servicingView's keys), the 02 §1.5 history view, the loan_terms facts, the docs/ux/12 key the model may point at, the plain words
/** `record_fields` are keys of `servicingView(record).view` (agent/servicing-context.ts); `history` a 02 §1.5 view; `terms` the latest loan_terms facts (grace, late-charge rate); `library_copy_key` the docs/ux/12 line the app renders for the same fact (a reference, never the model's sentence). The words carry no digit: every figure the model may write is a `{{token}}` the tool hands back. */
export interface ServicingExplainTopic { readonly record_fields: readonly string[]; readonly history: HistoryView | null; readonly terms: boolean; readonly library_copy_key: string | null; readonly text: string }
export const SERVICING_EXPLAIN_TOPICS: Readonly<Record<string, ServicingExplainTopic>> = {
  balance: { record_fields: ["status", "balance", "next_payment", "escrow_balance", "days_past_due", "autopay"], history: null, terms: true, library_copy_key: "account.current", text: "The balance is the principal still owed on the note; it goes down with the principal part of each payment and with anything extra sent toward principal. The next payment is the installment the note sets — principal and interest, plus the escrow share when the loan has an escrow account — due on its due date, with a grace period before any late charge." },
  payment_applied: { record_fields: ["balance", "next_payment"], history: "payments", terms: false, library_copy_key: "payment.posted", text: "Each payment is applied in a fixed order: the interest due first, then principal, then the escrow share, then any late charge or fee that is due. Whatever is left after a full installment goes to principal when the borrower asked for that, otherwise to fees, otherwise it is held. A payment smaller than a full installment is held until the rest arrives, and returned if it does not." },
  escrow: { record_fields: ["escrow", "next_payment"], history: "escrow", terms: false, library_copy_key: "escrow.statement", text: "Escrow is a set-aside held with the mortgage payment to pay property taxes, homeowner's insurance and any mortgage insurance when they come due, so those bills never land all at once. Each month a share of the payment goes into it; each line is paid to its payee on its own schedule; once a year the account is reviewed and the monthly share adjusted." },
  escrow_analysis: { record_fields: ["escrow", "next_payment"], history: "escrow", terms: false, library_copy_key: "escrow.statement", text: "Once a year the escrow account is reviewed: the taxes, insurance and other lines due in the coming year are projected, the balance is compared with what those payments need plus a cushion, and the new monthly escrow share is set. The statement shows the projection, the new amount and its effective date, and any surplus, shortage or deficiency." },
  escrow_shortage: { record_fields: ["escrow"], history: "escrow", terms: false, library_copy_key: "escrow.shortage.choice", text: "A shortage means the escrow balance is below what the coming year's taxes and insurance need. The borrower chooses how to make it up — spread over the coming year's payments, or paid at once — and the monthly escrow share changes to match the new projection either way. The choice is a card, never a sentence." },
  late_charge: { record_fields: ["next_payment", "days_past_due", "status"], history: null, terms: true, library_copy_key: "late_charge.assessed", text: "A late charge applies only when a payment arrives after the grace period the note allows past the due date. It is a share of the principal-and-interest part of the payment, set by the note, never of the escrow share, and a payment is always applied to the installment before any late charge." },
  payoff: { record_fields: [], history: null, terms: false, library_copy_key: "payoff.quote_spoken", text: "A payoff figure is the balance plus the interest that accrues each day through a stated good-through date, plus any fees due, less anything held for the borrower; the escrow balance is refunded separately. Because interest accrues daily the figure changes every day and is good only through its date, so it lives on the payoff card with that date, and a written statement follows within the time the rule allows." },
  autopay: { record_fields: ["autopay", "next_payment"], history: null, terms: true, library_copy_key: "autopay.active", text: "Autopay drafts the payment from a bank account on a chosen day each month, so nothing is late. Enrolling shows every element the rule requires and takes a typed name on a card; a copy of the authorization follows; the amount changes only with notice when the escrow share changes; it can be changed, paused or turned off at any time, and it is never a condition of the loan." },
  hardship: { record_fields: ["hardship", "status", "days_past_due"], history: "lossmit", terms: false, library_copy_key: "hardship.open", text: "When a payment is going to be hard, saying so starts a request for help: what changed and whether it is temporary is recorded, and that becomes an application for assistance. It is acknowledged within a few business days with anything else that is needed, every option the program allows is evaluated — a repayment plan, forbearance, a deferral or a modification — and the decision arrives with its reasons and a right to appeal. Nothing on the loan changes the day the borrower asks, and asking never counts against them." },
  rate_watch: { record_fields: ["rate_watch", "rate"], history: null, terms: false, library_copy_key: "ratewatch.worth_it", text: "Rate watch is the standing check on the loan: every day the loan's rate is compared with what is available for a loan like it, and the borrower is told only when a change is worth it — a meaningfully lower rate with a real saving over time and no cost to them. Nothing is promised and nothing is sent unless there is an offer; the borrower can ask at any time." },
  statements: { record_fields: ["next_payment"], history: "statements", terms: false, library_copy_key: "statement.available", text: "A statement is produced for each payment cycle and delivered electronically when e-delivery is on, otherwise by mail. Each shows the amount due and its date, the last payment and how it was applied, the balances and any fees; past statements stay under Documents." },
};

// ---------------------------------------------------------------- card.request: the cards a borrower may ask for in words (§4 "card.request for payments and changes"; Stage 4) — data, then the builders
/** An argument the model may transcribe into the ask (a figure or a date the borrower named, an option): the card's editable default or the command's own argument, never a commit. */
export interface RequestArg { readonly type: "string" | "integer"; readonly description: string; readonly pattern?: string; readonly enum?: readonly string[]; readonly minimum?: number; readonly maximum?: number }
/** kind → the card the owning flow raises for the same ask (docs/ux/08a–10): its kind, copy key, command, owner and the args the model may pass. Every kind's card kind is a §2.3 case on the `card.request` trigger (CARD_CASES); a DocumentCard is not, so a statement copy points at the statement's own card instead of minting one. */
export interface RequestSpec { readonly stage: "origination" | "servicing" | "any"; readonly kind: string; readonly copy_key: string; readonly command_ref: string | null; readonly owner: string; readonly description: string; readonly args: Readonly<Record<string, RequestArg>> }
export const HARDSHIP_REASONS: readonly string[] = ["unemployment", "reduction_in_income", "disability_or_illness", "divorce_or_legal_separation", "death_of_borrower_or_wage_earner", "disaster", "other"];
export const CALLBACK_WINDOWS: readonly string[] = ["morning", "afternoon", "evening"];
const ARG: Readonly<Record<string, RequestArg>> = {
  amount_cents: { type: "string", description: "the amount the borrower named, as a decimal string of cents (five hundred dollars → \"50000\"); the card's editable default", pattern: "^[0-9]{1,12}$" },
  draft_day: { type: "integer", description: "the day of the month to draft on (the 1st → 1); 1 to 16", minimum: 1, maximum: 16 },
  good_through: { type: "string", description: "the payoff's good-through date the borrower has in mind (YYYY-MM-DD); today plus fifteen days when omitted", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  text: { type: "string", description: "the borrower's own words (the assertion of error, the hardship) transcribed, not summarised" },
  hardship_reason: { type: "string", description: "what changed, as one of the listed reasons", enum: HARDSHIP_REASONS },
  document_class: { type: "string", description: "the class of document the borrower will send (homeowners_policy, paystub, other …)", pattern: "^[a-z0-9_]{1,64}$" },
  cycle_due_date: { type: "string", description: "the statement cycle's due date (YYYY-MM-DD); the latest statement when omitted", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  phone: { type: "string", description: "the number to call, as the borrower gave it", pattern: "^[+0-9()\\-. ]{7,24}$" },
  window: { type: "string", description: "the best time to call", enum: CALLBACK_WINDOWS },
  employer: { type: "string", description: "the employer's name as the borrower said it (the typed income card's editable default)", pattern: "^[^\\n]{1,120}$" },
  institution: { type: "string", description: "the bank or institution as the borrower said it (the typed assets card's editable default)", pattern: "^[^\\n]{1,120}$" },
};
export const CARD_REQUESTS: Readonly<Record<string, RequestSpec>> = {
  payment: { stage: "servicing", kind: "PaymentCard", copy_key: "payment.due", command_ref: "payment.makeOneTime", owner: "32.8 §3.1 paymentCard", description: "a one-time payment of the installment: the amount as its editable default, the dates through the grace end, the account; a fresh code on the tap", args: {} },
  extra_principal: { stage: "servicing", kind: "PaymentCard", copy_key: "payment.extra_principal", command_ref: "payment.extraPrincipal", owner: "32.8 §3.2 extraPrincipalCard", description: "extra principal (a curtailment); amount_cents is the figure the borrower named, the card's editable default; a fresh code on the tap", args: { amount_cents: ARG["amount_cents"]! } },
  autopay_enroll: { stage: "servicing", kind: "ConsentCard", copy_key: "autopay.enroll", command_ref: "autodraft.enroll", owner: "32.8 §4 autopayEnrollCard", description: "set up autopay: the enrollment consent with every Reg E element, drafting on draft_day; the borrower adds the account and types their name on the card; the authorization card follows", args: { draft_day: ARG["draft_day"]! } },
  autopay_change: { stage: "servicing", kind: "ChoiceCard", copy_key: "autopay.change.choice", command_ref: "autodraft.change", owner: "32.8 §4 autopayChoiceCard", description: "move the draft day of the active autopay to draft_day", args: { draft_day: ARG["draft_day"]! } },
  autopay_pause: { stage: "servicing", kind: "ChoiceCard", copy_key: "autopay.pause.choice", command_ref: "autodraft.pause", owner: "32.8 §4 autopayChoiceCard", description: "pause the active autopay", args: {} },
  autopay_revoke: { stage: "servicing", kind: "ChoiceCard", copy_key: "autopay.revoke.choice", command_ref: "autodraft.revoke", owner: "32.8 §4 autopayChoiceCard", description: "turn autopay off (never argued against)", args: {} },
  payoff_quote: { stage: "servicing", kind: "ChoiceCard", copy_key: "payoff.written.choice", command_ref: "case.open", owner: "32.9 §5.3 / 16.1 computePayoffQuote", description: "a payoff quote: the engine's figure through good_through lives on the card (never in your sentence); the tap requests the written statement", args: { good_through: ARG["good_through"]! } },
  escrow_shortage: { stage: "servicing", kind: "ChoiceCard", copy_key: "escrow.shortage.choice", command_ref: "escrow.electShortage", owner: "32.8 §6.2 escrowShortageCard", description: "the escrow shortage choice (spread it or pay it now) when an analysis with a shortage awaits the borrower's election", args: {} },
  hardship: { stage: "servicing", kind: "ChoiceCard", copy_key: "hardship.solicitation.start", command_ref: "lossmit.requestAssistance", owner: "32.10 §3", description: "start a request for help (the loss mitigation intake) with what changed; nothing on the loan changes today", args: { hardship_reason: ARG["hardship_reason"]!, text: ARG["text"]! } },
  upload: { stage: "any", kind: "UploadCard", copy_key: "documents.upload.fallback", command_ref: "document.upload", owner: "32.13 T-X-12", description: "an upload of a document only the borrower holds", args: { document_class: ARG["document_class"]! } },
  callback: { stage: "servicing", kind: "ConfirmCard", copy_key: "callback.request", command_ref: "case.open", owner: "4.3 / 32.16 §1 principle 8", description: "a callback request: the number and the best time are confirmed on the card and logged as a written request (no live agent is staffed; promise no time)", args: { phone: ARG["phone"]!, window: ARG["window"]! } },
  dispute: { stage: "servicing", kind: "ChoiceCard", copy_key: "case.noe.confirm", command_ref: "case.open", owner: "4.1 / 32.9 §5.2", description: "a notice of error: the assertion as understood, logged as a written notice on the tap (an acknowledgment follows; no fee, ever)", args: { text: ARG["text"]! } },
  statement_copy: { stage: "servicing", kind: "DocumentCard", copy_key: "statement.available", command_ref: null, owner: "32.8 §5 / 7.1", description: "a statement: the statement's own card under Documents (never a new card); by mail when e-delivery is off", args: { cycle_due_date: ARG["cycle_due_date"]! } },
  paperless: { stage: "servicing", kind: "ConsentCard", copy_key: "consent.esign.servicing", command_ref: "consent.capture", owner: "32.7 §6 item 3 / 7.4", description: "e-delivery of statements and notices: the E-SIGN consent card (checkbox and typed name there, never in words)", args: {} },
  // ---- origination (Stage 3): the typed paths of 32.3 R3 / SQ-01 and SQ-03 — the borrower would rather state a figure than connect an account; the assistant proposes into the card and the tap commits
  income: { stage: "origination", kind: "ConfirmCard", copy_key: "income.confirm.title", command_ref: "application.confirmField", owner: "32.3 R3 type-it-in (SQ-03) / 32.16 T4", description: "the typed monthly income (the payroll connection's fallback): the employer and the monthly base as the borrower states them, confirmed on the card and written as their stated income (source borrower); amount_cents and employer are the card's editable defaults", args: { amount_cents: ARG["amount_cents"]!, employer: ARG["employer"]! } },
  assets: { stage: "origination", kind: "ConfirmCard", copy_key: "assets.confirm.title", command_ref: "application.confirmField", owner: "32.3 SQ-01 typed assets (a bank connection only when DU asks)", description: "the typed asset account: the institution, the account type and the approximate balance as the borrower states them, confirmed on the card as a stated fact (statements or a bank connection verify it later); amount_cents and institution are the editable defaults", args: { amount_cents: ARG["amount_cents"]!, institution: ARG["institution"]! } },
};
/** The args the model passed, validated against the kind's schema (a bad value refuses the call before anything runs); unknown keys are dropped. */
export function requestArgs(kind: string, raw: P): P {
  const spec = CARD_REQUESTS[kind]; const out: P = {}; if (!spec) return out;
  for (const [k, a] of Object.entries(spec.args)) {
    const v = raw[k]; if (v === undefined || v === null || v === "") continue;
    if (a.type === "integer") { const n = Number(v); if (!Number.isInteger(n) || (a.minimum !== undefined && n < a.minimum) || (a.maximum !== undefined && n > a.maximum)) throw new AgentToolRefused("CARD_REQUEST_ARGS", `${k} must be a whole number${a.minimum !== undefined ? ` from ${a.minimum}` : ""}${a.maximum !== undefined ? ` to ${a.maximum}` : ""}`); out[k] = n; continue; }
    const s = String(v).trim();
    if (a.pattern && !new RegExp(a.pattern).test(s)) throw new AgentToolRefused("CARD_REQUEST_ARGS", `${k}: ${a.description}`);
    if (a.enum && !a.enum.includes(s)) throw new AgentToolRefused("CARD_REQUEST_ARGS", `${k} must be one of ${a.enum.join("/")}`);
    out[k] = s.slice(0, 2000);
  }
  return out;
}
type Built = { readonly spec: CardSpec; readonly tokens?: Record<string, string>; readonly note: string } | { readonly existing: CardInstanceRow; readonly note: string; readonly detail?: P } | { readonly refused: string; readonly copy_key: string; readonly note: string };
interface BuildInput { readonly s: Situation; readonly loanId: string | null; readonly facts: PaymentFacts | null; readonly args: P; readonly flow_key: string; readonly utterance: string; readonly ctx: CommandContext; readonly rt: ToolRuntime }
const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
const enrollments = (f: PaymentFacts): { id: string; data: P }[] => f.store.list("autodraft_enrollments", (d) => d.loan_id === f.loanId).map((r) => ({ id: r.id, data: r.data as P }));
const NO_LOAN: Built = { refused: "NO_SERVICED_LOAN", copy_key: "error.not_yours", note: "this card exists only on a serviced loan" };
const autopayVerb = (verb: "change" | "pause" | "revoke") => async ({ facts, flow_key, args }: BuildInput): Promise<Built> => {
  if (!facts) return NO_LOAN;
  const live = verb === "pause" ? ["active"] : ["active", "paused", "suspended_returns"];
  const rec = enrollments(facts).filter((r) => live.includes(String(r.data["status"]))).at(-1);
  if (!rec) return { refused: "AUTOPAY_NOT_ON", copy_key: "error.generic", note: `there is no ${verb === "pause" ? "active" : "active or paused"} autopay enrollment to ${verb}: offer autopay_enroll instead` };
  const spec = autopayChoiceCard(verb, rec, `${flow_key}:${rec.id}`, { draft_day: typeof args["draft_day"] === "number" ? args["draft_day"] : null });
  return { spec, tokens: { "request.draft_day": ordinal(Number(spec.props["draft_day"])), "request.account_last4": `••••${String((spec.props["copy_tokens"] as P)["last4"] ?? "")}` }, note: verb === "change" ? "the change card is on the rail: drafts move to the {{request.draft_day}} once the borrower taps it (a fresh code); nothing changes until then" : verb === "pause" ? "the pause card is on the rail; autopay keeps drafting until the borrower taps it (a fresh code)" : "the card to turn autopay off is on the rail; the tap ends it (a fresh code) — never argue against it" };
};
const BUILDERS: Readonly<Record<string, (b: BuildInput) => Promise<Built>>> = {
  payment: async ({ facts, flow_key }) => (facts ? { spec: paymentCard(facts, flow_key), note: "the payment card is on the rail: the installment as its default, the dates through the grace end, the account to pay from; a fresh code on the tap; never say it is paid" } : NO_LOAN),
  extra_principal: async ({ facts, flow_key, args }) => {
    if (!facts) return NO_LOAN;
    const amount = typeof args["amount_cents"] === "string" ? args["amount_cents"] : null; const spec = extraPrincipalCard(facts, flow_key, { amount_cents: amount });
    return { spec, tokens: amount ? { "request.amount": usd(amount) ?? amount } : {}, note: `the extra-principal card is on the rail${amount ? " with {{request.amount}} as its editable default" : ""}; ${spec.props["applies"] === "redirected_to_cure" ? "an installment is past due, so the money goes to bring the loan current first — say so" : "on a current loan it goes to principal the day it is received"}; a fresh code on the tap; never say it is done` };
  },
  autopay_enroll: async ({ s, facts, flow_key, args }) => {
    if (!facts) return NO_LOAN;
    const open = enrollments(facts).find((r) => ["requested", "authorized", "validating", "active", "paused"].includes(String(r.data["status"])));
    if (open) return { refused: "AUTOPAY_ALREADY_ON", copy_key: "autopay.active", note: `autopay is already ${String(open.data["status"])} on this loan: offer autopay_change, autopay_pause or autopay_revoke instead` };
    const draft_day = typeof args["draft_day"] === "number" ? args["draft_day"] : 1;
    return { spec: autopayEnrollCard(facts, { party_id: s.party.id, legal_name: s.party.legal_name }, flow_key, { draft_day }), tokens: { "request.draft_day": ordinal(draft_day) }, note: "the enrollment card is on the rail with every element the rule requires: drafts on the {{request.draft_day}} of each month; the borrower adds the account and types their name there (a fresh code), then an authorization card follows; never say autopay is on" };
  },
  autopay_change: autopayVerb("change"), autopay_pause: autopayVerb("pause"), autopay_revoke: autopayVerb("revoke"),
  payoff_quote: async ({ s, facts, loanId, flow_key, args, ctx, rt }) => {
    if (!facts || !loanId) return NO_LOAN;
    const n = (s.record?.numbers ?? {}) as P; const upb = n["upb_cents"];
    if (upb === null || upb === undefined || !facts.terms.first_payment_date) return { refused: "PAYOFF_UNAVAILABLE", copy_key: "error.generic", note: "the ledger carries no balance for this loan yet, so no figure can be quoted here; offer the written statement through command_run case.open{kind: payoff_request}" };
    const today = D(ctx.now.slice(0, 10)); const good_through = typeof args["good_through"] === "string" ? args["good_through"] : addDays(today, 15);
    if (good_through < today) return { refused: "PAYOFF_GOOD_THROUGH_PAST", copy_key: "error.generic", note: "the good-through date is in the past: ask again with a date from today on" };
    const posted = facts.store.list("payments", (d) => d.loan_id === loanId && d.status === "posted" && (d.designation ?? "contractual") === "contractual").length;
    const pt = paidThrough(D(facts.terms.first_payment_date), posted, today); const quote_id = `pq-portal-${loanId.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
    const q = await delegate(rt, ctx, "16.1", "computePayoffQuote", { loan_id: loanId, upb_cents: String(upb), rate_pct: String(n["note_rate"] ?? facts.terms.note_rate_pct), lpi_due: pt.lpi_due, state: String((s.record?.property as P | null)?.["state"] ?? "") || "OH", ledger_snapshot_id: `ledger:${loanId}:${ctx.now}`, quote_type: "portal", mode: "portal", channel: "app", identity_verified: true, quote_id, requested_at: ctx.now, good_through }) as P;
    const total = String(q["total_cents"] ?? ""); const gt = String(q["good_through"] ?? good_through);
    return { spec: { kind: "ChoiceCard", copy_key: "payoff.written.choice", flow_key: `${flow_key}:${gt}`, command_ref: "case.open", props: { title: "", helper: "", options: [{ id: "send", label: "Yes, send it", is_primary: true }, { id: "not_now", label: "Not now" }], command: "case.open", command_args_by_option: { send: { kind: "payoff_request", text: `Written payoff statement requested after the portal quote ${quote_id}` }, not_now: {} }, no_command_options: ["not_now"], portal_quote_id: quote_id, quote_id, total_cents: total, per_diem_cents: String(q["per_diem_cents"] ?? ""), good_through: gt, figure_on_card: true, copy_tokens: { money: usd(total) ?? "", date: gt }, affirmatives: ["send it", "yes send it", "send the statement"] } },
      note: "the payoff card carries today's figure and its good-through date: the figure lives on the card and never in your sentence — say why it changes daily (interest accrues every day) and that the card's tap requests the written statement" };
  },
  escrow_shortage: async ({ facts }) => {
    if (!facts) return NO_LOAN;
    const open = openShortage(facts); if (!open) return { refused: "ESCROW_NO_SHORTAGE", copy_key: "escrow.statement", note: "no escrow shortage awaits a choice (no approved analysis with a shortage and its statement sent, or the choice was already made): explain escrow_analysis instead" };
    return { spec: escrowShortageCard(open.analysis, open.decision), note: "the shortage choice is on the rail with the analysis's own figures — spread over the plan's months or pay now; a fresh code on the tap; the amounts are on the card, not in your sentence" };
  },
  hardship: async ({ s, facts, loanId, flow_key, args, utterance }) => {
    if (!facts || !loanId) return NO_LOAN;
    const qrpc = s.cards.find((c) => c.status === "pending" && c.copy_key === "hardship.qrpc.confirm" && c.subject_loan_id === loanId);
    if (qrpc) return { existing: qrpc, note: "a request for help is already open: the read-back of what was understood is pending on the rail — ask the borrower to confirm or correct it there; promise no outcome, name no eligibility" };
    const openApp = facts.store.list("lossmit_applications", (d) => d.loan_id === loanId && !["closed", "withdrawn", "denied", "decided", "complete", "completed"].includes(String(d.status))).at(-1);
    if (openApp) return { refused: "HARDSHIP_ALREADY_OPEN", copy_key: "hardship.application.received", note: `a request for help is already in (${String(openApp.data["status"] ?? "received")}): say it is being worked and what comes next (explain hardship); promise no outcome, name no eligibility` };
    const reason = typeof args["hardship_reason"] === "string" ? args["hardship_reason"] : null; const text = typeof args["text"] === "string" ? args["text"] : utterance; const state = String((s.record?.property as P | null)?.["state"] ?? "") || null;
    return { spec: { kind: "ChoiceCard", copy_key: "hardship.solicitation.start", flow_key, command_ref: "lossmit.requestAssistance", props: { title: "", options: [{ id: "start", label: "Start", is_primary: true }, { id: "not_now", label: "Not now" }], command: "lossmit.requestAssistance", command_args_by_option: { start: { ...(reason ? { hardship_reason: reason } : {}), ...(text ? { hardship_text: text } : {}), ...(state ? { state } : {}) }, not_now: {} }, no_command_options: ["not_now"], ...(reason ? { hardship_reason: reason } : {}), affirmatives: ["start", "yes start"] } }, note: "the request-for-help card is on the rail; say plainly that starting it changes nothing on the loan today and that every option is looked at; promise no outcome, name no eligibility, never a decline" };
  },
  income: async ({ s, flow_key, args }) => {
    if (s.subject?.stage !== "origination" || !s.subject.application_id) return { refused: "NOT_AVAILABLE", copy_key: "error.generic", note: "the typed income card exists only on an application being originated" };
    const amount = typeof args["amount_cents"] === "string" ? args["amount_cents"] : ""; const employer = typeof args["employer"] === "string" ? args["employer"] : "";
    return { spec: { kind: "ConfirmCard", copy_key: "income.confirm.title", flow_key, command_ref: "application.confirmField", props: { title: "", fields: [{ path: "employer", label: "Employer", value: employer, source: "borrower" }, { path: "monthly_income", label: "Monthly income", value: amount, source: "borrower" }], commits_to: "application_income", money_paths: ["monthly_income"], required_paths: ["monthly_income"], statement: "This becomes the income you're stating on your application.", typed_path: true, command_args: { path: "income", commits_to: "application_income" } } },
      ...(amount ? { tokens: { "request.amount": usd(amount) ?? amount } } : {}), note: `the typed income card is on the rail${amount ? " with {{request.amount}} a month as its editable default" : ""}: propose what the borrower said into it (monthly_income in cents, the employer) and ask them to tap Confirm; nothing counts until the tap, and pay stubs are asked for later` };
  },
  assets: async ({ s, flow_key, args }) => {
    if (s.subject?.stage !== "origination" || !s.subject.application_id) return { refused: "NOT_AVAILABLE", copy_key: "error.generic", note: "the typed assets card exists only on an application being originated" };
    const amount = typeof args["amount_cents"] === "string" ? args["amount_cents"] : ""; const institution = typeof args["institution"] === "string" ? args["institution"] : "";
    return { spec: { kind: "ConfirmCard", copy_key: "assets.confirm.title", flow_key, command_ref: "application.confirmField", props: { title: "", fields: [{ path: "asset_institution", label: "Bank or institution", value: institution, source: "borrower" }, { path: "asset_account_type", label: "Account type", value: "checking", source: "borrower", options: [{ id: "checking", label: "Checking" }, { id: "savings", label: "Savings" }, { id: "brokerage", label: "Brokerage" }, { id: "retirement", label: "Retirement" }] }, { path: "asset_balance_cents", label: "Approximate balance", value: amount, source: "borrower" }], commits_to: "application_assets", money_paths: ["asset_balance_cents"], required_paths: ["asset_institution", "asset_balance_cents"], statement: "This is the account you're stating on your application; statements or a bank connection verify it later.", typed_path: true, command_args: { path: "assets", commits_to: "application_assets" } } },
      ...(amount ? { tokens: { "request.amount": usd(amount) ?? amount } } : {}), note: `the typed assets card is on the rail${amount ? " with {{request.amount}} as its editable default" : ""}: propose what the borrower said into it (the institution, the account type as its option id, the balance in cents) and ask them to tap Confirm; a bank connection is asked for only if underwriting needs it` };
  },
  upload: async ({ flow_key, args }) => { const cls = typeof args["document_class"] === "string" ? args["document_class"] : "other"; return { spec: { kind: "UploadCard", copy_key: "documents.upload.fallback", flow_key: `${flow_key}:${cls}`, command_ref: "document.upload", props: { document_class: cls, accepted_examples: ["a PDF or a photo"], why: "", title: "", command_args: { document_class: cls } } }, note: "the upload card is on the rail; say what to send in one line" }; },
  callback: async ({ s, facts, flow_key, args }) => {
    if (!facts) return NO_LOAN;
    const onFile = ((): string | null => { const c = s.party.contact; const v = c["phone"] ?? c["mobile"] ?? (Array.isArray(c["phones"]) ? (c["phones"] as unknown[])[0] : null); return typeof v === "string" && v ? v : null; })();
    const phone = typeof args["phone"] === "string" ? args["phone"] : onFile; const window = typeof args["window"] === "string" ? args["window"] : "";
    return { spec: { kind: "ConfirmCard", copy_key: "callback.request", flow_key, command_ref: "case.open", props: { title: "", fields: [{ path: "phone", label: "Number to call", value: phone ?? "", source: typeof args["phone"] === "string" ? "borrower_stated_unconfirmed" : onFile ? "on_file" : "borrower" }, { path: "window", label: "Best time to call", value: window, source: "borrower", options: CALLBACK_WINDOWS.map((w) => ({ id: w, label: w.charAt(0).toUpperCase() + w.slice(1) })) }], required_paths: ["phone", "window"], commits_to: "cases", command_args: { kind: "general_inquiry", text: "Callback requested — the number and the best time to call are the fields confirmed on this card." } } },
      tokens: phone ? { "request.phone": phone } : {}, note: `the callback card is on the rail: the number${phone ? " ({{request.phone}})" : ""} and the best time are confirmed there and the tap logs the written request; no live agent is staffed, so promise no time` };
  },
  dispute: async ({ facts, flow_key, args, utterance }) => {
    if (!facts) return NO_LOAN;
    const text = (typeof args["text"] === "string" ? args["text"] : utterance).trim(); if (!text) return { refused: "DISPUTE_TEXT_REQUIRED", copy_key: "error.generic", note: "pass the borrower's words as text" };
    return { spec: { kind: "ChoiceCard", copy_key: "case.noe.confirm", flow_key: `${flow_key}:${sha(text).slice(0, 8)}`, command_ref: "case.open", props: { title: "", options: [{ id: "log", label: "Log it as a notice of error", is_primary: true }, { id: "not_now", label: "Not now" }], command: "case.open", command_args_by_option: { log: { kind: "noe", text }, not_now: {} }, no_command_options: ["not_now"], assertion_text: text, affirmatives: ["log it", "yes log it"] } }, note: "the notice-of-error card is on the rail with the assertion as understood; the tap logs it as a written notice — an acknowledgment follows within the time the rule allows and there is never a fee; say that in your words" };
  },
  statement_copy: async ({ s, loanId, args, rt }) => {
    if (!loanId) return NO_LOAN;
    const want = typeof args["cycle_due_date"] === "string" ? args["cycle_due_date"] : null;
    const doc = s.cards.filter((c) => c.kind === "DocumentCard" && c.copy_key === "statement.available" && c.subject_loan_id === loanId && (!want || c.props["cycle_due_date"] === want)).sort((a, b) => String(b.props["cycle_due_date"] ?? "").localeCompare(String(a.props["cycle_due_date"] ?? "")))[0];
    if (doc) return { existing: doc, note: "the statement is on the rail under Documents — that card is its viewer: refer to it and never restate its figures", detail: { document_id: doc.props["document_id"] ?? null, cycle_due_date: doc.props["cycle_due_date"] ?? null } };
    const rows = await new BorrowerRecordReader(dbOf(rt)).history(loanId, "statements");
    const cycle = rows.find((r) => (!want || r["cycle_due_date"] === want) && ["sent", "delivered", "fallback_mailed", "bounced"].includes(String(r["status"])));
    if (cycle && (String(cycle["channel"] ?? "").startsWith("mail") || cycle["status"] === "fallback_mailed")) return { refused: "STATEMENT_MAILED", copy_key: "statement.paper_until_esign", note: "that statement went by mail because e-delivery is off: offer the e-delivery card (card_request paperless) so the next one is here" };
    return { refused: "STATEMENT_NOT_AVAILABLE", copy_key: "documents.not_available", note: "no statement has been issued for that cycle yet; the first one arrives before the payment's due date" };
  },
  paperless: async ({ s, loanId, flow_key, rt }) => {
    if (!loanId) return NO_LOAN;
    const active = Number((await dbOf(rt).query<{ n: string }>(`SELECT count(*)::text AS n FROM consents WHERE kind = 'esign' AND status = 'active' AND (party_id = $1 OR loan_id = $2)`, [s.party.id, loanId]))[0]?.n ?? 0);
    if (active > 0) return { refused: "ESIGN_ALREADY_ACTIVE", copy_key: "statement.available", note: "e-delivery is already on for this loan's statements and notices" };
    return { spec: { kind: "ConsentCard", copy_key: "consent.esign.servicing", flow_key, command_ref: "consent.capture", props: { consent_kind: "esign", disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE", scope: [...SERVICING_ESIGN_SCOPES], affirmation_method: "checkbox_with_text", title: "", body_text: "", footer_text: "", requires_typed_name: true, verification_state: "none", paper_until_active: true, command_args: { kind: "esign", method: "checkbox_with_text", scope: [...SERVICING_ESIGN_SCOPES], disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE", purpose: "informational" } } }, note: "the e-delivery consent is on the rail: the borrower checks the box and types their name there, never in words; statements stay on paper until it is active" };
  },
};

// ---------------------------------------------------------------- the decision record (32.16 decision schema: every call is a bus command with a row)
const decisionFor = (name: string) => (i: ToolInput, out: unknown, ctx: CommandContext) => {
  const o = out as P | null; const card = str(i, "card_instance_id");
  return { action: `agent.tool:${name}`, rationale: `32.16 ${name} party_id=${str(i, "party_id") || "-"} conversation_id=${str(i, "conversation_id") || "-"} message_id=${str(i, "message_id") || "-"}${o && typeof o["outcome"] === "string" ? ` outcome=${o["outcome"]}` : ""} by ${ctx.actor.kind}:${ctx.actor.id}`, subject: card ? { kind: "card_instance", id: card } : { kind: "conversation", id: str(i, "conversation_id") || str(i, "party_id") || "-" } };
};
type Def = Omit<ToolDef, "process" | "agent">;
const tool = (name: string, handler: (i: ToolInput, ctx: CommandContext, rt: ToolRuntime) => unknown | Promise<unknown>, extra: Partial<Def> = {}): Def => ({ name, kind: "act", handler: compute(handler), decision: decisionFor(name), ...extra });
const subjectInput = (s: Subject | null, i: ToolInput): P => ({ ...(s?.application_id ? { application_id: s.application_id } : {}), ...(s?.loan_id ? { loan_id: s.loan_id } : {}), party_id: str(i, "party_id"), ...(str(i, "session_id") ? { session_id: str(i, "session_id") } : {}), ...(str(i, "assurance_level") ? { assurance_level: str(i, "assurance_level") } : {}), fresh_l1: false, channel: str(i, "channel") || "app" });

export const TOOLS_32_16: readonly ToolDef[] = defineTools(PROCESS_32_16, INTAKE, [
  tool("session.next", async (i, ctx, rt) => { const s = await situationOf(i, ctx, rt); return { ...sessionNextOf(s.record, s.cards), outcome: "read" }; }),

  tool("record.get", async (i, ctx, rt) => {
    const s = await situationOf(i, ctx, rt);
    const r = compactRecord(s.record, { level: str(i, "assurance_level") || "L1", partyFirstName: s.party.legal_name.split(/\s+/)[0] ?? s.party.legal_name });
    // `tokens` is for the API (agent/tools.ts strips it and fills the reply); the model reads the view, whose figures are `{{token}}`s.
    // A serviced loan adds its own block (agent/servicing-context.ts): the next installment, the escrow lines, autopay, MI, hardship, rate watch — the same way, as tokens
    const sv = servicingView(s.record);
    return { record: { ...r.view, ...(Object.keys(sv.view).length ? { servicing: sv.view } : {}) }, tokens: { ...r.tokens, ...sv.tokens }, outcome: "read" };
  }),

  tool("explain", async (i, ctx, rt) => {
    need(i, "topic"); const topic = str(i, "topic").toLowerCase().replace(/[^a-z_]/g, "_");
    if (topic === "rates") {
      // 20.3 rule 7 through 20.2's checklist (32.14 lead.requestRange on the party's lead): the element the API renders; the model gets no figure
      const lead = rt.store.list("leads", (d) => d.party_id === str(i, "party_id")).map((r) => r.data as P).at(-1);
      if (!lead) return { topic, copy_key: "explain.rates", outcome: "refused", refused: RATES_UNAVAILABLE, note: "no lead record to price against yet; say the published rates come once the home's state is known" };
      const partner_nmlsr_id = String(rt.store.get("partners", String(lead["partner_id"]))?.data["nmlsr_id"] ?? "");
      let r: P;
      try { r = await delegate(rt, ctx, "32.14", "lead.requestRange", { lead_id: String(lead["lead_id"]), at: ctx.now, ...(partner_nmlsr_id ? { partner_nmlsr_id } : {}) }) as P; }
      catch (e) { return { topic, copy_key: "explain.rates", outcome: "refused", refused: (e as { code?: string }).code ?? RATES_UNAVAILABLE, note: `the published range cannot be shown yet (${e instanceof Error ? e.message.slice(0, 160) : String(e)}); say so without a number` }; }
      const range = r["range"] && typeof r["range"] === "object" ? (r["range"] as P) : null;
      if (!range) return { topic, copy_key: "explain.rates", outcome: "refused", refused: String(r["refused"] ?? RATES_UNAVAILABLE), note: "the published range did not pass its content check; say the rates are not available right now, without a number" };
      const element = { element: "rates", product: String(range["product_label"] ?? range["product_code"] ?? ""), low_rate: String(range["low_pct"]), low_apr: String(range["apr_low_pct"]), high_rate: String(range["high_pct"]), high_apr: String(range["apr_high_pct"]), lender: String(lead["partner_name"] ?? ""), nmlsr_id: partner_nmlsr_id, rate_sheet_id: String(range["rate_sheet_id"] ?? ""), as_of: ctx.now };
      return { topic, copy_key: "explain.rates", outcome: "shown", element, shown: true, note: "the checked rates element (rates with APRs, the lender and its NMLSR ID) is shown beside your reply; refer to it as the rates shown here and restate no figure" };
    }
    if (topic === "program") {
      const s = await situationOf(i, ctx, rt); const tt = (s.record?.subject.transaction_type ?? "limited_cash_out") as "purchase" | "limited_cash_out" | "cash_out";
      const p = explainProgram({ transaction_type: ["purchase", "limited_cash_out", "cash_out"].includes(tt) ? tt : "limited_cash_out", ...(s.record?.subject.occupancy ? { occupancy: s.record.subject.occupancy } : {}) });
      return { topic, copy_key: "explain.program", classification: "general_explanation", criteria: p.criteria.map((c) => c.replace(/\d+(\.\d+)?%/g, "the program's limit")), decision_timeline: p.decision_timeline.replace(/\b\d+ days\b/, "the time Reg B allows"), outcome: "explained" };
    }
    const servicing = SERVICING_EXPLAIN_TOPICS[topic];
    if (servicing) {
      // a serviced loan's topic answers from its own record and history (agent/servicing-context.ts): the figures and dates as tokens, never computed here; without a loan the generic words below stand
      const s = await situationOf(i, ctx, rt); const loanId = s.subject?.loan_id ?? null;
      if (loanId && s.record) {
        const sv = servicingView(s.record); const tokens: Record<string, string> = { ...sv.tokens }; const facts: P = {};
        for (const k of servicing.record_fields) if (sv.view[k] !== undefined) facts[k] = sv.view[k];
        if (servicing.history) { const h = historyView(servicing.history, await new BorrowerRecordReader(dbOf(rt)).history(loanId, servicing.history)); facts["history"] = h.view; Object.assign(tokens, h.tokens); }
        if (servicing.terms) { const f = await paymentFacts(dbOf(rt), loanId, { events: ctx.events.byLoan(loanId), store: rt.store, now: ctx.now }); const t = termsView(f.terms); facts["terms"] = t.view; Object.assign(tokens, t.tokens); }
        return { topic, copy_key: `explain.${topic}`, library_copy_key: servicing.library_copy_key, classification: "general_explanation", text: servicing.text, facts, tokens, outcome: "explained", note: topic === "payoff" ? "paraphrase in your own words and state no figure: the payoff figure exists only on the payoff card (card_request payoff_quote)" : "paraphrase in your own words; the facts' values are {{tokens}} you may write verbatim; a figure or date that is not a token does not exist" };
      }
      if (!EXPLAIN_TOPICS[topic]) return { topic, outcome: "refused", refused: "NO_SERVICED_LOAN", copy_key: "error.not_yours", note: "this topic is about a serviced loan and the borrower has none yet" };
    }
    const fromLibrary = copyText(`explain.${topic}`); const text = fromLibrary.startsWith("{{copy:") ? EXPLAIN_TOPICS[topic] : fromLibrary;
    if (!text) return { topic, outcome: "refused", refused: "TOPIC_NOT_IN_LIST", topics: Object.keys(EXPLAIN_TOPICS).concat(["rates", "program"]), note: "explain answers only the listed topics; for anything else say you will note it for a person" };
    return { topic, copy_key: `explain.${topic}`, classification: "general_explanation", text, outcome: "explained", note: "paraphrase in your own words, then return to the current ask" };
  }),

  tool("timer.due", async (i, ctx, rt) => {
    need(i, "code"); const code = str(i, "code");
    if (!timerAllowed(code)) throw new AgentToolRefused("TIMER_NOT_ALLOWED", `${code} is not a borrower-visible clock (02 §4 allow-list)`);
    const s = await situationOf(i, ctx, rt);
    const t = (await dbOf(rt).query<{ due_at: string | null; status: string }>(`SELECT due_at, status FROM timers WHERE (($1::uuid IS NOT NULL AND application_id = $1) OR ($2::uuid IS NOT NULL AND loan_id = $2)) AND code = $3 ORDER BY armed_at DESC LIMIT 1`, [s.subject?.application_id ?? null, s.subject?.loan_id ?? null, code]))[0];
    if (!t || !t.due_at) return { code, label: timerLabel(code), status: t?.status ?? "not_armed", due_at: null, outcome: "read" };
    return { code, label: timerLabel(code), status: t.status, due_at: `{{dates.${code}}}`, tokens: { [`dates.${code}`]: t.due_at.slice(0, 10) }, outcome: "read" };
  }),

  tool("document.describe", async (i, ctx, rt) => {
    need(i, "document_id"); const id = str(i, "document_id"); if (!isUuid(id)) throw new RangeError("document_id must be a uuid");
    const s = await situationOf(i, ctx, rt);
    const d = (await dbOf(rt).query<{ id: string; kind: string; doc_class: string | null; received_at: string | null; metadata: P }>(`SELECT id, kind, doc_class, received_at, metadata FROM documents WHERE id = $1 AND (($2::uuid IS NOT NULL AND application_id = $2) OR ($3::uuid IS NOT NULL AND loan_id = $3))`, [id, s.subject?.application_id ?? null, s.subject?.loan_id ?? null]))[0];
    if (!d) throw new AgentToolRefused("DOCUMENT_NOT_VISIBLE", "no such document on this party's record", "documents.not_available");
    const inRecord = (s.record?.documents ?? []).find((x) => x["document_id"] === id || x["id"] === id);
    const cls = d.doc_class ?? (inRecord?.["notice_code"] as string | undefined) ?? d.kind; const status = String(inRecord?.["status"] ?? (d.received_at ? "received" : "pending"));
    return { document_id: id, class: cls, kind: d.kind, status, line: `${cls.replace(/_/g, " ")} — ${status}`, outcome: "read" };   // one line; never contents
  }),

  tool("card.propose", async (i, ctx, rt) => {
    need(i, "card_instance_id"); const id = str(i, "card_instance_id"); if (!isUuid(id)) throw new RangeError("card_instance_id must be a uuid");
    const db = dbOf(rt); const card = await new PgBorrowerUiRepository(db).card(id);
    if (!card || card.party_id !== str(i, "party_id")) throw new AgentToolRefused("PARTY_SCOPE", "the card is not this party's", "error.not_yours");
    if (card.status !== "pending") throw new AgentToolRefused("CARD_NOT_PENDING", `the card is ${card.status}`, "thread.card_not_pending");
    if (!PROPOSABLE_KINDS.has(card.kind)) throw new AgentToolRefused("CARD_PROPOSE_KIND", `a ${card.kind} is never answered in words — the borrower resolves it on the card`, "thread.card_needs_tap");
    if (card.command_ref && NEVER_PROPOSE_COMMANDS.has(card.command_ref)) throw new AgentToolRefused("CARD_PROPOSE_NEVER_IN_WORDS", `${card.command_ref} is the borrower's own act on the card (a consent, a declaration, a demographic answer, a payment) — never taken in words`, "thread.card_needs_tap");
    const props = card.props; const money = new Set(Array.isArray(props["money_paths"]) ? (props["money_paths"] as string[]) : []);
    const masked = new Set(Array.isArray(props["masked_paths"]) ? (props["masked_paths"] as string[]) : []);
    const known = new Map((Array.isArray(props["fields"]) ? (props["fields"] as P[]) : []).map((f) => [String(f["path"] ?? ""), f] as const));
    for (const p of [...(Array.isArray(props["required_paths"]) ? (props["required_paths"] as string[]) : []), ...money]) if (!known.has(p)) known.set(p, { path: p });
    const fieldsIn = Array.isArray(i["fields"]) ? (i["fields"] as P[]) : []; const option_id = str(i, "option_id") || null;
    const fields: { path: string; value: string; source: "borrower_stated_unconfirmed" }[] = [];
    if (card.kind === "ChoiceCard") {
      const options = (Array.isArray(props["options"]) ? (props["options"] as P[]) : []).map((o) => String(o["id"]));
      if (!option_id || !options.includes(option_id)) throw new AgentToolRefused("PROPOSAL_INVALID", `option_id must be one of ${options.join("/")}`);
    } else {
      if (!fieldsIn.length) throw new AgentToolRefused("PROPOSAL_INVALID", "fields[] {path, value} is required");
      for (const f of fieldsIn) {
        const path = String(f["path"] ?? ""); const value = f["value"] === undefined || f["value"] === null ? "" : String(f["value"]).trim();
        const spec = known.get(path); if (!spec) throw new AgentToolRefused("PROPOSAL_INVALID", `${path} is not a path this card asks for (${[...known.keys()].join(", ")})`);
        // 01 §5 / 32.3 E5: a masked field (the SSN) is typed on the card once and never travels through the thread — no proposal, no read-back
        if (masked.has(path)) throw new AgentToolRefused("CARD_PROPOSE_MASKED", `${path} is typed on the card only and never repeated in the conversation`, "thread.card_needs_tap");
        if (!value) throw new AgentToolRefused("PROPOSAL_INVALID", `${path} needs a value`);
        // the model transcribes, never calculates: money is a decimal string of cents, a choice is its option id, an enumerated field is ULAD-valid (21.1)
        if ((money.has(path) || /_cents$/.test(path)) && !/^\d+$/.test(value)) throw new AgentToolRefused("PROPOSAL_INVALID", `${path} must be a decimal string of cents (e.g. "820000" for eight thousand two hundred dollars)`);
        if (Array.isArray(spec["options"]) && !(spec["options"] as P[]).some((o) => String(o["id"]) === value)) throw new AgentToolRefused("PROPOSAL_INVALID", `${path} must be one of ${(spec["options"] as P[]).map((o) => o["id"]).join("/")}`);
        if (path in ULAD_ENUMS) { const v = validateUlad(path, value); if (!v.valid) throw new AgentToolRefused("PROPOSAL_INVALID", v.reason ?? `${path} is not valid`); }
        fields.push({ path, value, source: "borrower_stated_unconfirmed" });
      }
    }
    const prior = props["proposal"] && typeof props["proposal"] === "object" ? (props["proposal"] as P) : null;
    // §3.7: a proposal replacing an unconfirmed one means the earlier read-back was rejected — a miss; the third goes to a human (the turn runs human.request)
    const missInc = prior ? 1 : 0; const misses = Number(card.misses ?? 0) + missInc;
    const proposal = { ...(fields.length ? { fields } : {}), ...(option_id ? { option_id } : {}), utterance_message_id: str(i, "message_id") || null, proposed_at: ctx.now, proposed_by: `agent:${ctx.actor.id}` };
    defer(rt, async (q) => { await q.query(`UPDATE card_instances SET props = props || $2::jsonb, misses = misses + $3 WHERE card_instance_id = $1 AND status = 'pending'`, [id, toJson({ proposal }), missInc]); });
    ctx.events.append({ type: "card.proposed", ...(card.subject_loan_id ? { loanId: card.subject_loan_id } : {}), ...(card.subject_application_id ? { applicationId: card.subject_application_id } : {}), aggregate: { kind: "card_instance", id }, actor: ctx.actor, payload: { card_instance_id: id, party_id: card.party_id, kind: card.kind, copy_key: card.copy_key, paths: fields.map((f) => f.path), option_id, misses, message_id: str(i, "message_id") || null } });
    // the read-back tokens (`{{proposal.<path>}}` / `{{proposal.option}}`): the API fills them; the model never writes the figure
    const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }); const tokens: Record<string, string> = {};
    for (const f of fields) { const spec = known.get(f.path); const opt = Array.isArray(spec?.["options"]) ? (spec!["options"] as P[]).find((o) => String(o["id"]) === f.value) : undefined; tokens[`proposal.${f.path}`] = money.has(f.path) || /_cents$/.test(f.path) ? USD.format(Number(BigInt(f.value)) / 100) : opt ? String(opt["label"] ?? f.value) : f.value; }
    if (option_id) tokens["proposal.option"] = String((props["options"] as P[]).find((o) => String(o["id"]) === option_id)?.["label"] ?? option_id);
    return { card_instance_id: id, kind: card.kind, copy_key: card.copy_key, proposal: { ...(fields.length ? { fields } : {}), ...(option_id ? { option_id } : {}) }, misses, resolved: false, tokens, outcome: "proposed", note: `nothing is written until the borrower taps Confirm on the card; read the values back in your words as ${Object.keys(tokens).map((k) => `{{${k}}}`).join(", ")} and ask them to confirm` };
  }, { guardrails: [never("CARD_PROPOSE_NEVER_RESOLVES", "docs/ux/17 §1 principle 6: words never commit — a proposal resolves nothing", (i) => i["resolve"] === true || i["confirm"] === true || i["evidence"] !== undefined, "the model proposes; only the borrower's tap (resolveCard) commits")] }),

  tool("card.request", async (i, ctx, rt) => {
    need(i, "kind"); const kind = str(i, "kind").toLowerCase(); const spec = CARD_REQUESTS[kind]; const build = BUILDERS[kind];
    if (!spec || !build) throw new AgentToolRefused("CARD_REQUEST_KIND", `${kind} is not a card the borrower may ask for (${Object.keys(CARD_REQUESTS).join(", ")})`);
    const args = requestArgs(kind, obj(i, "args"));
    const s = await situationOf(i, ctx, rt);
    if (!s.subject) throw new AgentToolRefused("SUBJECT_REQUIRED", "no application or loan yet", "error.not_yours");
    if (spec.stage !== "any" && s.subject.stage !== spec.stage) return { kind, sent: false, outcome: "refused", refused: "NOT_AVAILABLE", copy_key: spec.stage === "servicing" ? "error.not_yours" : "error.generic", note: `a ${kind} card exists only on a ${spec.stage} subject` };
    if (s.record?.read_only) return { kind, sent: false, outcome: "refused", refused: "SUBJECT_TERMINAL", copy_key: "error.read_only", note: "the file is closed: only a case, a callback or a contact update goes through" };
    // the owning flow's facts inside this unit of work: the loan's seeded log and entity rows, the command's clock, the latest loan_terms (flows/8-servicing-payments.ts paymentFacts)
    const loanId = s.subject.loan_id; const facts = loanId ? await paymentFacts(dbOf(rt), loanId, { events: ctx.events.byLoan(loanId), store: rt.store, now: ctx.now }) : null;
    const built = await build({ s, loanId, facts, args, flow_key: `request.${kind}:${s.subject.application_id ?? s.subject.loan_id}`, utterance: str(i, "utterance"), ctx, rt });
    if ("refused" in built) return { kind, sent: false, outcome: "refused", refused: built.refused, copy_key: built.copy_key, note: built.note };
    if ("existing" in built) return { kind, sent: true, card_instance_id: built.existing.card_instance_id, card_kind: built.existing.kind, copy_key: built.existing.copy_key, outcome: "on_rail", ...(built.detail ?? {}), note: built.note };
    const c = built.spec;
    const pending = s.cards.find((x) => x.status === "pending" && x.props["flow_key"] === c.flow_key);
    if (pending) return { kind, sent: true, card_instance_id: pending.card_instance_id, card_kind: pending.kind, copy_key: pending.copy_key, outcome: "already_pending", ...(built.tokens ? { tokens: built.tokens } : {}), note: `the card is already on the rail, still waiting for the borrower's tap; ${built.note}` };
    const r = await delegate(rt, ctx, "32.1", "send_card", { party_id: s.party.id, kind: c.kind, copy_key: c.copy_key, command_ref: c.command_ref ?? null, body_text: c.body_text ?? null, expires_at: c.expires_at ?? null, props: { ...c.props, flow_key: c.flow_key, flow: PROCESS_32_16, requested_by: "card.request", requested_message_id: str(i, "message_id") || null }, subject: { application_id: s.subject.application_id, loan_id: s.subject.loan_id }, created_by: `agent:${ctx.actor.id}`, trigger: "card.request", rationale: `32.16 card.request ${kind} on message ${str(i, "message_id") || "-"} (${spec.owner})` }) as P;
    return { kind, sent: true, card_instance_id: r["card_instance_id"], card_kind: c.kind, copy_key: c.copy_key, command_ref: c.command_ref ?? null, outcome: "sent", ...(built.tokens ? { tokens: built.tokens } : {}), note: built.note };
  }),

  tool("command.run", async (i, ctx, rt) => {
    need(i, "name"); const name = str(i, "name"); const process = COMMAND_PROCESS[name]; if (!process) throw new AgentToolRefused("COMMAND_OUTSIDE_CONTRACT", `${name} is not a command a turn may run`);
    const s = await situationOf(i, ctx, rt); const args = obj(i, "args");
    const out = await delegate(rt, ctx, process, name, { ...args, ...subjectInput(s.subject, i), ...(name === "human.request" ? { reason: str(args, "reason") || "borrower_request", utterance: str(args, "utterance") || str(i, "utterance") || "", transcript_ref: str(i, "conversation_id") ? `conversation:${str(i, "conversation_id")}#${str(i, "message_id") || "-"}` : null } : {}) }) as P;
    return { name, process, outcome: "executed", result: out };
  }, { guardrails: [never("COMMAND_OUTSIDE_CONTRACT", "docs/ux/17 §3.3: command.run issues the borrower-initiated non-money, non-consent commands only; a money command, a consent or a resolve is refused before anything runs", (i) => !COMMAND_RUN_ALLOWLIST.includes(str(i, "name")), `only ${COMMAND_RUN_ALLOWLIST.join(", ")} may run from a turn`)] }),

  tool("human.transfer", async (i, ctx, rt) => {
    const s = await situationOf(i, ctx, rt); const reason = str(i, "reason") || "borrower_request";
    // the party's lead and its interaction: 32.2 human.request then runs 20.3's warm transfer on it (the FAKE reviewer or a person completes it with `human_joined`)
    const lead = rt.store.list("leads", (d) => d.party_id === str(i, "party_id")).map((r) => r.data as P).at(-1); const interaction = ((lead?.["interactions"] as P[] | undefined) ?? []).at(-1);
    const out = await delegate(rt, ctx, "32.2", "human.request", { ...subjectInput(s.subject, i), reason, utterance: str(i, "utterance") || "", ...(str(i, "card_instance_id") ? { card_instance_id: str(i, "card_instance_id") } : {}), ...(lead && interaction ? { lead_id: String(lead["lead_id"]), interaction_id: String(interaction["interaction_id"]) } : {}), transcript_ref: str(i, "conversation_id") ? `conversation:${str(i, "conversation_id")}#${str(i, "message_id") || "-"}` : null }) as P;
    return { requested: true, reason, escalation_id: out["escalation_id"] ?? null, outcome: "requested", note: "the request is queued; no live agent is staffed yet — say so plainly and offer a callback request, a written dispute or a case" };
  }),
]);

// ---------------------------------------------------------------- the model-facing schema (generated from the definitions at boot — agent/tools.ts turns it into Anthropic.Tool[])
export interface ModelToolSchema { readonly name: string; readonly model_name: string; readonly description: string; readonly input_schema: P }
const SCHEMAS: Readonly<Record<string, Omit<ModelToolSchema, "name" | "model_name">>> = {
  "session.next": { description: "The current ask on the borrower's record: the pending card with the highest priority (kind, copy key, what it asks for, what may be answered, topics to avoid), or idle with what we are doing. Call it first when unsure where things stand.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  "record.get": { description: "The borrower's compact record: status, next step, what is needed from them and from us, numbers, dates, documents, people, property and loan. Every figure, date and name comes back as a {{token}} you may write verbatim in your reply.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  "explain": { description: `A plain-words explanation of one topic: ${Object.keys(EXPLAIN_TOPICS).join(", ")}, program (this program's criteria), or rates (today's published rate range — the system then shows the checked rates element beside your reply; you restate no figure). On a serviced loan also ${Object.keys(SERVICING_EXPLAIN_TOPICS).join(", ")}: answered from the loan's own record and history, every figure and date a {{token}} you may write verbatim — never a figure of your own; payoff hands back no figure (the payoff card carries it).`, input_schema: { type: "object", properties: { topic: { type: "string", description: "one of the listed topics, program, rates, or a serviced loan's topic" } }, required: ["topic"], additionalProperties: false } },
  "timer.due": { description: "The due date of one borrower-visible clock by its code (as listed on the record's dates), returned as a {{token}}.", input_schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false } },
  "document.describe": { description: "One line about a document on the record by its id: its class and status. Never its contents.", input_schema: { type: "object", properties: { document_id: { type: "string" } }, required: ["document_id"], additionalProperties: false } },
  "card.propose": { description: "Propose what the borrower just said into the pending card so they can tap Confirm: fields [{path, value}] for a confirm or profile card (money as a decimal string of cents, a choice as its option id, transcribed never calculated) or option_id for a choice card. It writes nothing until they confirm. Refused for a consent, the credit authorization, the declarations, the demographics, a payment and any masked field (the Social Security number): those are the borrower's own act on the card — say so and point to the card.", input_schema: { type: "object", properties: { card_instance_id: { type: "string" }, fields: { type: "array", items: { type: "object", properties: { path: { type: "string" }, value: { type: "string" } }, required: ["path", "value"], additionalProperties: false } }, option_id: { type: "string" } }, required: ["card_instance_id"], additionalProperties: false } },
  "card.request": { description: `Put a card the borrower asked for on the rail — money and consents are cards, never words: ${Object.entries(CARD_REQUESTS).map(([k, s]) => `${k} (${s.description})`).join("; ")}. Pass what the borrower named in args (a figure as a decimal string of cents, a day, a date, their words); it becomes the card's editable default or the command's argument, never a commit. Returns the card on the rail (say what it is for in one line and refer to it; never say it is done), the card already there, or the reason it is not available.`, input_schema: { type: "object", properties: { kind: { type: "string", enum: Object.keys(CARD_REQUESTS) }, args: { type: "object", description: "the kind's optional args (see the kind's description)", properties: Object.fromEntries(Object.entries(ARG).map(([k, a]) => [k, { type: a.type, description: a.description, ...(a.enum ? { enum: [...a.enum] } : {}), ...(a.pattern ? { pattern: a.pattern } : {}), ...(a.minimum !== undefined ? { minimum: a.minimum } : {}), ...(a.maximum !== undefined ? { maximum: a.maximum } : {}) }])), additionalProperties: false } }, required: ["kind"], additionalProperties: false } },
  "command.run": { description: `Run one borrower-initiated command: ${COMMAND_RUN_ALLOWLIST.join(", ")} (a callback request, a written dispute or a case are the ways to reach a person). Money, consents and confirmations are cards, never commands here.`, input_schema: { type: "object", properties: { name: { type: "string", enum: [...COMMAND_RUN_ALLOWLIST] }, args: { type: "object", additionalProperties: true } }, required: ["name"], additionalProperties: false } },
  "human.transfer": { description: "Queue a request for a person with a reason. No live agent is staffed yet: tell the borrower plainly and offer a callback request, a written dispute or a case instead of promising a transfer.", input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false } },
};
/** The model-facing tool names (Anthropic tool names allow [a-zA-Z0-9_-]): `session.next` → `session_next`; agent/tools.ts maps them back. */
export const modelToolName = (name: string): string => name.replace(/\./g, "_");
export const MODEL_TOOLS_32_16: readonly ModelToolSchema[] = TOOLS_32_16.map((d) => { const s = SCHEMAS[d.name]; if (!s) throw new Error(`no model schema for 32.16 ${d.name}`); return { name: d.name, model_name: modelToolName(d.name), ...s }; });
