/**
 * The Journey (docs/ux/17 §3.2, 32.16-T29): the one object the model reads first on every turn — where the borrower is, what is
 * needed next in order, why each thing is needed, who owns it, when it is due and how it can be satisfied. It is a pure function of
 * the borrower record (needed_from_you, what_we_are_doing, journey_progress, dates) and the pending cards; nothing here is stored, and
 * nothing here decides — the engine still refuses anything the rules do not allow. The model decides what to ask and how; the
 * Journey tells it what is true and what is required.
 *
 * Figures, dates and names come through as `{{tokens}}` exactly as the compact record does (context.ts fills them after the guard).
 * This module imports nothing from DU, credit, fraud, QC or a vendor adapter and reads no table (32.16-T2's contract applies).
 */
import type { BorrowerRecord } from "../record.ts";
import type { CardInstanceRow } from "../../../infra/db/borrower-ui.ts";

type P = Record<string, unknown>;

export type NeedKind = "fact" | "choice" | "consent" | "connect" | "upload" | "document" | "signature" | "schedule" | "payment" | "acknowledge" | "other";
export interface JourneyNeed {
  /** the card instance, or the record item when no card carries it */
  readonly id: string;
  readonly card_instance_id: string | null;
  readonly kind: NeedKind;
  /** the ask in plain words (the record's own line for it) */
  readonly what: string;
  /** why the rules need it, in plain words, with the rule named — for the model's understanding, never to be quoted */
  readonly why: string;
  readonly process: string | null;
  readonly owner: "you";
  readonly due_at: string | null;
  /** how it gets satisfied: what the borrower can say or tap */
  readonly satisfy: string;
  /** a proposal from an earlier turn the turn could not write (a refusal) waits on the card with its copy */
  readonly proposal_pending: boolean;
  /** a gate holds this one (an earlier step first); the model should not ask for it yet */
  readonly blocked_by: string | null;
}
export interface Journey {
  readonly stage: "entry" | "origination" | "servicing";
  readonly transaction_type: string | null;
  /** the current journey step (R1–R12 / P1–P9, C1–C7) and the process it belongs to; null when a serviced loan or before the goal */
  readonly step: { readonly id: string; readonly label_copy_key: string; readonly process: string } | null;
  readonly progress: { readonly done: number; readonly total: number } | null;
  /** what is needed from the borrower, in the order to ask: unblocked first, in the record's own priority, a proposal the turn could not write first of all */
  readonly needs: readonly JourneyNeed[];
  /** what we or a third party are doing — nothing for the borrower to do about these */
  readonly waiting_on: readonly { readonly label: string; readonly owner: string; readonly status: string }[];
  /** the last steps completed, most recent first */
  readonly recently_done: readonly { readonly step: string; readonly label_copy_key: string }[];
  readonly next_deadline: { readonly label: string; readonly timer_code: string; readonly due_at: string } | null;
  /** the top need restated for the model in one line, or what to say when nothing is needed */
  readonly next_in_words: string;
}

/** Each journey step's owning process (spec/sections; the rules the model is handed for the step come from this file). */
export const STEP_PROCESS: Readonly<Record<string, string>> = {
  R1: "21.1", R2: "22.2", R3: "22.3", R4: "21.1", R5: "21.1", R6: "21.1", R7: "21.2", R8: "23.3", R9: "21.2", R10: "21.4", R11: "21.4", R12: "26.2",
  P1: "20.3", P2: "22.6", P3: "20.3", P4: "22.2", P5: "22.3", P6: "21.1", P7: "22.4", P8: "23.1", P9: "23.3", C1: "21.1", C2: "21.2", C3: "21.2", C4: "21.4", C5: "21.4", C6: "24.5", C7: "26.2",
};
/** Steps whose rules are underwriting, fraud or decision internals: the model gets no rules text for these (docs/ux/17 §3.5 (5) — never the internals; it says the file is with underwriting). */
export const INTERNAL_PROCESSES: ReadonlySet<string> = new Set(["22.6", "23.1", "23.2", "23.3", "23.4", "28.4", "28.1", "28.2"]);

const NEED_KIND: Readonly<Record<string, NeedKind>> = {
  ConfirmCard: "fact", ProfileCard: "fact", DemographicsCard: "fact", ChoiceCard: "choice", ComparisonCard: "choice", OfferCard: "choice", ConsentCard: "consent",
  ConnectCard: "connect", UploadCard: "upload", DocumentCard: "document", NoticeCard: "acknowledge", ScheduleCard: "schedule", PaymentCard: "payment", HandoffCard: "other", ChecklistCard: "other",
};
const SATISFY: Readonly<Record<NeedKind, string>> = {
  fact: "the borrower says it in words; you propose it into the card (card_propose) and the turn writes it — read it back; they correct it by saying so",
  choice: "the borrower picks in words; you propose the option (card_propose) and the turn writes it, or they tap the option on the card",
  consent: "a tap on the card only — a spoken yes is never a consent; say what it is for and that the tap is on the rail",
  connect: "a tap on the card launches the connection (about a minute); the fallback is typing it in or uploading",
  upload: "the borrower attaches the document on the card (the paperclip or the card's button); you can say what to send",
  document: "the borrower opens it on the rail, reads to the end and taps Confirm receipt",
  signature: "a signing session from the card — never in words",
  schedule: "the borrower picks a slot on the card; you can suggest the earliest",
  payment: "an amount and a date on the card, then a tap — a money command needs a fresh code; never in words",
  acknowledge: "a tap on the card",
  other: "on the card",
};

/** Why the rules need each ask, by the card's copy key (prefix match, longest first): plain words and the rule, for the model's understanding. */
const WHY: readonly (readonly [string, string])[] = [
  ["entry.goal", "the goal (buy, lower the rate or payment, cash out) decides which path the file takes; nothing else can be asked until it is known"],
  ["refi.home", "the home and the current loan are what a refinance replaces; the address decides the state's rules and the value estimate sizes the loan"],
  ["refi.current_loan", "the current balance and payment are what the new loan pays off; the daily rate check compares against them"],
  ["refi.value", "the value estimate sizes the loan-to-value, which decides pricing and whether mortgage insurance applies"],
  ["refi.loan_amount", "the loan amount fixes the estimate the rules must disclose; a change later is a changed circumstance"],
  ["refi.product", "the product (term, fixed or adjustable) is a term the lender must state on the Loan Estimate"],
  ["refi.name", "the legal name goes on every disclosure and the credit request; it must match the identity check"],
  ["refi.ssn", "the Social Security number is what the credit bureaus key the report on; the lender must verify identity before a credit pull"],
  ["refi.profile", "the application (the 1003) needs the borrower's employment, address history and contact details; the lender must collect them before underwriting"],
  ["refi.income", "income decides the ability to repay, which the lender must verify before it can approve (Reg Z ability-to-repay)"],
  ["income.connect", "a payroll connection is the fastest income proof; the rules accept it in place of pay stubs and it needs no upload"],
  ["income.confirm", "stated income is captured now and verified next; the lender must document it before underwriting (ability to repay)"],
  ["assets.confirm", "assets and reserves show the money to close is there and where it came from; large deposits and gifts need their own paper"],
  ["consent.esign", "electronic delivery of the disclosures needs the borrower's E-SIGN consent first; without it the papers go by mail"],
  ["consent.credit.soft", "a soft credit pull needs the borrower's say-so first; it does not affect the score and it is what the rate range is based on"],
  ["consent.credit", "a credit pull needs the borrower's authorization first (the Fair Credit Reporting Act); the report decides the terms"],
  ["consent.tcpa", "texts and calls need the borrower's consent first (the Telephone Consumer Protection Act); marketing consent is separate and optional"],
  ["consent.joint_intent", "each borrower on a joint application must confirm they intend to apply jointly (Reg B)"],
  ["consent.autodraft", "automatic payments need a written authorization the borrower can revoke at any time (Reg E)"],
  ["consent.irs", "tax transcripts need the borrower's own consent to the IRS before they can be requested"],
  ["consent.standing", "the standing consents (delivery, contact, credit) are the borrower's to manage at any time"],
  ["auth.identity", "identity must be verified before personal terms can be shown; a scan of an ID is fastest, typing it in works too"],
  ["identity.contact", "the account was opened on the call with no name and no e-mail: the name is how we address the borrower, the e-mail is how they get back into this conversation from any device if the call drops (a code goes to it). legal_name is the name exactly as they said it, first and last — never spelled, expanded, corrected or reconstructed from the e-mail address (an address like janedoe35@… says nothing about the name); if only a first name was given, ask for the last name before proposing. email is the spoken address normalized (at → @, dot → ., lower case, no spaces)"],
  ["identity.prior_residence", "under two years at the current address, the application (the 1003) needs the address before it: where, how they lived there (owned, rented with the rent, or rent-free) and for how many months"],
  ["identity.confirm", "the identity details must match the ID on file before a credit pull; a mismatch stops the file; the same card asks how they live at the address (own, rent with the monthly rent, or rent-free) and how many months they have been there, which every application needs"],
  ["identity.ssn", "the Social Security number keys the credit report; the lender must verify it before pulling credit"],
  ["credit.freeze", "a frozen bureau cannot be read; the borrower lifts the freeze with the bureau, then the pull is retried"],
  ["credit.liabilities", "the debts on the report must be confirmed or corrected; they feed the debt-to-income the rules test"],
  ["declarations", "the declarations (bankruptcy, foreclosure, lawsuits, ownership) are required on every application by the 1003 form"],
  ["demographics", "the government asks the questions on this card for fair-lending monitoring; answering is voluntary and the answers never affect the decision"],
  ["profile", "the application needs the borrower's employment and address history for underwriting"],
  ["contract.confirm", "the purchase contract fixes the price, the address and the closing date; the disclosures are built from it"],
  ["contract.seller", "a relationship to the seller changes what counts as an arm's-length sale; the rules ask so the file is treated correctly"],
  ["preapproval.where", "the state and the price range decide the rules and the products before anything is pulled"],
  ["preapproval.target", "the target price and down payment size the loan the pre-approval letter is written for"],
  ["preapproval", "the pre-approval letter is what the borrower shows sellers; it is issued once income, assets and credit are known"],
  ["intent", "the lender may not charge a fee or lock a rate until the borrower says they intend to proceed after seeing the Loan Estimate (TRID)"],
  ["le.", "the Loan Estimate must be received before the borrower can proceed; the rules count three business days from delivery unless receipt is confirmed"],
  ["revised_le", "a revised Loan Estimate follows a changed circumstance; the borrower confirms receipt so the clocks run from the right date"],
  ["lock", "locking fixes the rate until the expiry; floating means the rate can move either way until then"],
  ["cd.", "the Closing Disclosure must be received three business days before signing; confirming receipt starts that clock"],
  ["closing.schedule", "signing can only be scheduled once the disclosure waiting period is satisfied; the earliest slot is the earliest the rules allow"],
  ["closing", "closing details (electronic or paper, the notary, the settlement agent) are needed to prepare the signing session"],
  ["rescission", "a refinance of the home you live in comes with three business days to change your mind after signing; funding waits for it"],
  ["valuation.schedule", "the appraiser needs access to the home; the appointment is the borrower's to pick"],
  ["valuation", "the valuation supports the loan amount; the borrower is entitled to a copy before closing"],
  ["insurance", "hazard insurance must be in place before funding, with the lender named on the policy"],
  ["hoa", "a condo or planned-community loan needs the association's documents to pass project review"],
  ["upload", "a document the underwriter needs to clear a condition; the request says which one and why"],
  ["documents.upload", "a document the file needs; the request names it"],
  ["conditions", "conditions are what the underwriter still needs before the loan is clear to close"],
  ["mi.", "mortgage insurance applies when the down payment is under twenty percent; the choice affects the monthly payment"],
  ["autopay", "automatic payments are optional; they need a written authorization and can be paused or cancelled any time"],
  ["payment", "a payment posts to the loan the day it is received; the amount and date are the borrower's choice"],
  ["escrow", "the escrow account pays taxes and insurance; the annual analysis can produce a shortage or a surplus the borrower decides about"],
  ["pmi", "private mortgage insurance can be cancelled at 80 percent loan-to-value on request and ends automatically at 78 (the Homeowners Protection Act)"],
  ["hardship", "a hardship application is reviewed under the servicing rules; the borrower's answers decide which options apply (Reg X)"],
  ["payoff", "a payoff statement is the borrower's right on request; the written statement is the one that counts"],
  ["callback", "a callback request is logged as a written request; someone will call at the time chosen"],
  ["case.noe", "a notice of error is a written dispute the servicer must acknowledge and answer within fixed days (Reg X)"],
  ["successor", "a successor in interest must be confirmed with documents before the servicer can share the loan's details"],
  ["statement", "the periodic statement is the record of the month; the borrower confirms they can see it"],
  ["boarding", "after funding the loan moves to servicing; the first-payment letter and the investor notice explain where to pay"],
  ["first_payment", "the first payment date and payee come from the note; the letter is required after funding"],
  ["refi.request", "a refinance request opens a new application on the file already known"],
  ["ratewatch", "rate watch is the daily check; the borrower decides whether to be told when a refinance would help"],
  ["decision", "an application decision must be explained in writing; a counteroffer is the borrower's to accept or decline"],
  ["human", "a person joins when asked or when the rules require one"],
  ["explain", "an explanation the borrower asked for"],
  ["team", "the people on the file and how to reach them"],
];
const whyOf = (copyKey: string): string => {
  let best: string | null = null; let len = -1;
  for (const [prefix, why] of WHY) if (copyKey.startsWith(prefix) && prefix.length > len) { best = why; len = prefix.length; }
  return best ?? "the rules of the current step need it before the file can move on";
};

const dateOf = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/** The step a card belongs to, by its copy key, when the current step's own family does not own it — used only to name the process for `why`. */
function processOf(copyKey: string, kind: string, stepProcess: string | null): string | null {
  const k = copyKey;
  if (/^(income|refi\.income)/.test(k)) return "22.3";
  if (/^assets/.test(k)) return "22.4";
  if (/^(credit|consent\.credit|refi\.ssn|identity\.ssn)/.test(k)) return "22.2";
  if (/^identity\.contact/.test(k)) return "32.17";
  if (/^(auth\.identity|identity)/.test(k)) return "22.6";
  if (/^(consent\.esign|consent\.tcpa|entry\.)/.test(k)) return "20.3";
  if (/^(intent|lock)/.test(k)) return "21.4";
  if (/^(le\.|revised_le|cd\.)/.test(k)) return k.startsWith("cd.") ? "25.2" : "21.2";
  if (/^(closing|rescission)/.test(k)) return k.startsWith("rescission") ? "25.3" : "26.2";
  if (/^(valuation)/.test(k)) return "24.1";
  if (/^(insurance|flood)/.test(k)) return "24.5";
  if (/^(hoa)/.test(k)) return "24.3";
  if (/^(mi\.)/.test(k)) return "24.6";
  if (/^(upload|documents|conditions)/.test(k)) return "22.1";
  if (/^(declarations|demographics|profile|refi\.(home|current_loan|value|loan_amount|product|name|profile)|contract)/.test(k)) return "21.1";
  if (/^(autopay|payment|consent\.autodraft)/.test(k)) return "2.1";
  if (/^escrow/.test(k)) return "3.2";
  if (/^pmi/.test(k)) return "10.1";
  if (/^hardship/.test(k)) return "12.1";
  if (/^payoff/.test(k)) return "16.1";
  if (/^(case|callback)/.test(k)) return "4.1";
  if (/^successor/.test(k)) return "4.4";
  if (/^statement/.test(k)) return "7.1";
  if (/^(boarding|first_payment)/.test(k)) return "30.4";
  if (kind === "DocumentCard" || kind === "NoticeCard") return "7.1";
  return stepProcess;
}

export interface JourneyInput {
  readonly record: BorrowerRecord | null;
  readonly cards: readonly CardInstanceRow[];
  /** the needed line's rendered text per item (copy library), when the record carries a copy key; the label otherwise */
  readonly labelOf?: (item: { label: string; label_copy_key?: string; copy_tokens?: Record<string, string> }) => string;
}

/** The Journey as the model sees it, plus the tokens its `{{…}}` placeholders fill from. */
export function buildJourney(i: JourneyInput): { journey: Journey; tokens: Record<string, string> } {
  const tokens: Record<string, string> = {};
  const record = i.record;
  const pending = i.cards.filter((c) => c.status === "pending");
  const byId = new Map(pending.map((c) => [c.card_instance_id, c] as const));
  const jp = record?.journey_progress ?? null;
  const current = jp?.steps.find((s) => s.state === "current") ?? null;
  const stepProcess = current ? STEP_PROCESS[current.id] ?? null : record?.subject.stage === "servicing" ? "2.1" : null;
  const stage: Journey["stage"] = !record ? "entry" : record.subject.stage;

  // the needs: the record's own order (its needed_from_you is the priority list), then any pending ask-kind card the record does not list, oldest first
  const seen = new Set<string>();
  const needs: JourneyNeed[] = [];
  const push = (card: CardInstanceRow | null, item: BorrowerRecord["needed_from_you"][number] | null) => {
    const id = card?.card_instance_id ?? item?.item_id ?? ""; if (!id || seen.has(id)) return; seen.add(id);
    const kind: NeedKind = card ? NEED_KIND[card.kind] ?? "other" : item?.kind === "consent" ? "consent" : item?.kind === "connector" ? "connect" : item?.kind === "document_request" ? "upload" : item?.kind === "signature" ? "signature" : item?.kind === "schedule" ? "schedule" : item?.kind === "acknowledgment" ? "acknowledge" : "fact";
    const copyKey = card?.copy_key ?? item?.label_copy_key ?? "";
    const what = item ? (i.labelOf ? i.labelOf(item) : item.label) : card ? String((card.props as P)["title"] ?? card.copy_key) : id;
    const due = item?.due_at ?? (card?.expires_at ?? null);
    if (due) tokens[`journey.${id.replace(/-/g, "").slice(0, 8)}.due_at`] = dateOf(due) ?? String(due);
    const props = (card?.props ?? {}) as P;
    const gate = typeof props["gate"] === "string" ? String(props["gate"]) : null;
    needs.push({
      id, card_instance_id: card?.card_instance_id ?? null, kind, what, why: whyOf(copyKey), process: processOf(copyKey, card?.kind ?? "", stepProcess), owner: "you",
      due_at: due ? `{{journey.${id.replace(/-/g, "").slice(0, 8)}.due_at}}` : null, satisfy: SATISFY[kind],
      proposal_pending: !!(props["proposal"] && typeof props["proposal"] === "object"), blocked_by: gate,
    });
  };
  for (const item of record?.needed_from_you ?? []) { const card = item.card_instance_id ? byId.get(item.card_instance_id) ?? null : null; if (card || !item.card_instance_id) push(card, item); }
  const ASK_KINDS = new Set(["ConfirmCard", "ProfileCard", "DemographicsCard", "ChoiceCard", "ComparisonCard", "OfferCard", "ConsentCard", "ConnectCard", "UploadCard", "ScheduleCard", "PaymentCard", "DocumentCard"]);
  for (const c of [...pending].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))) {
    if (!ASK_KINDS.has(c.kind)) continue;
    if (c.kind === "DocumentCard" && (c.props as P)["requires_ack"] !== true) continue;
    if (c.kind === "ConnectCard") { const st = String((c.props as P)["state"] ?? ""); if (st && !["not_started", "failed", "in_progress"].includes(st)) continue; }
    push(c, null);
  }
  // order: a proposal the turn could not write first (the borrower already answered it), then unblocked in record order, then blocked
  const ordered = [...needs.filter((n) => n.proposal_pending), ...needs.filter((n) => !n.proposal_pending && !n.blocked_by), ...needs.filter((n) => !n.proposal_pending && n.blocked_by)];

  const waiting_on = (record?.what_we_are_doing ?? []).map((d) => ({ label: d.label, owner: d.owner, status: d.status }));
  const recently_done = jp ? [...jp.steps].filter((s) => s.state === "done").reverse().slice(0, 3).map((s) => ({ step: s.id, label_copy_key: s.label_copy_key })) : [];
  let next_deadline: Journey["next_deadline"] = null;
  if (record?.next) { tokens["journey.next_deadline"] = dateOf(record.next.due_at) ?? record.next.due_at; next_deadline = { label: record.next.label, timer_code: record.next.timer_code, due_at: "{{journey.next_deadline}}" }; }

  const top = ordered[0] ?? null;
  const next_in_words = top
    ? top.proposal_pending
      ? `the borrower already answered "${top.what}" in words and it waits for their Confirm tap on the card — remind them gently, then move on only after the tap`
      : `the next thing is "${top.what}" (${top.kind}): ${top.why}. How it gets done: ${top.satisfy}. Lead with it in your own words; offer the easiest way when there is one; take a later item first only when the borrower brings it up.`
    : waiting_on.length
      ? `nothing is needed from the borrower right now; we are waiting on ${waiting_on.map((w) => `${w.label} (${w.owner})`).join(", ")} — say so plainly and offer to explain or to help with anything else`
      : "nothing is needed from the borrower right now — say so, and ask what they would like to do or know";

  const journey: Journey = {
    stage, transaction_type: record?.subject.transaction_type ?? null,
    step: current ? { id: current.id, label_copy_key: current.label_copy_key, process: STEP_PROCESS[current.id] ?? "" } : null,
    progress: jp ? { done: jp.done, total: jp.total } : null,
    needs: ordered, waiting_on, recently_done, next_deadline, next_in_words,
  };
  return { journey, tokens };
}
