/**
 * The utterance guard (docs/ux/17 §3.5, DELTA-25) — before every reply is sent. Seven checks over the model's sentence:
 *
 *   (1) provenance   no raw money, percentage, date, phone, NMLSR or account figure outside a `{{token}}` — no digit at all outside a
 *                    token, and no spelled-out amount or percentage either; rejected → regenerated once with the violation named, then
 *                    the step's default copy
 *   (2) compliance   a turn that talks about rates carries the rates element (the 20.3 checked range as structured data on its own
 *                    row) and restates none of its figures; a reply that equals a copy-library template verbatim is rejected — the
 *                    two things the law wants said are interface, never the model's sentence (§1 principle 8)
 *   (3) SAFE         the class (regex baseline; the turn's data_capture when the model proposed), then 21.1's utterancePermission /
 *                    logSafeActivity through the bus: assisted mode presents no particular terms before mlo.review.completed;
 *                    negotiation and underwriting_communication are never the model's — the reply is the step's default copy
 *   (4) inquiries    21.1 scanTranscript — a hit quarantines the prompt version (the turn runner stops using it) and the reply is the
 *                    step's default copy
 *   (5) scope        no DU, credit, fraud, QC or compliance internals; no eligibility statement before DU; no decline language ever
 *   (6) disclosure   the session's first row is the disclosure record (rendered as the header); "are you a real person?" is answered
 *                    in the model's words, and the reply must say it is automated and offer a way to reach a person
 *   (7) substance    the reply leads with what the loan needs next in plain words (docs/ux/17 §1 principle 5, §3.7): a line under
 *                    MIN_REPLY_WORDS words once its tokens are filled, or a bare question with no content ("What next?"), is rejected
 *                    and regenerated once — the demo's "What next?" reply is what this check refuses
 *
 * Pure over its input (the turn runner supplies the SAFE permission it got from the bus); every rejection becomes an `agent_turns` row.
 */
import { scanTranscript, type SafeClassification } from "../../../domain/application/ops-21-1.ts";

type P = Record<string, unknown>;
export interface CopyTemplate { readonly key: string; readonly text: string }
export interface SafePermission { readonly allowed: boolean; readonly classification: SafeClassification; readonly fallback: SafeClassification | null; readonly reason: string | null; readonly source: "bus" | "local" }
export interface GuardInput {
  readonly text: string;
  readonly borrowerText: string;
  readonly tokens: Readonly<Record<string, string>>;
  /** The turn appended a rates element (explain{topic: rates} shown) — and its figures, which the sentence may not restate. */
  readonly ratesElementShown: boolean;
  readonly ratesFigures: readonly string[];
  readonly templates: readonly CopyTemplate[];
  readonly classification: SafeClassification;
  readonly safe: SafePermission;
  readonly promptVersion: string;
  readonly utteranceId: string;
  readonly disclosureFirst: boolean;
}
export interface GuardCheck { readonly ok: boolean; readonly detail: string | null }
export interface GuardResult {
  readonly ok: boolean;
  /** The first failing check's name; null when the reply passed. */
  readonly rejected_by: string | null;
  readonly violation: string | null;
  /** A rejection the model may fix (one regeneration); false → the step's default copy at once. */
  readonly regenerable: boolean;
  readonly quarantine_prompt_version: string | null;
  readonly classification: SafeClassification;
  readonly checks: Readonly<Record<"provenance" | "compliance" | "safe" | "inquiries" | "scope" | "disclosure" | "substance", GuardCheck>>;
}

// ---------------------------------------------------------------- (7) substance: the reply carries the next item in words, never a bare question
/** The fewest words a reply may carry once its `{{token}}`s are filled (docs/ux/17 §3.7: the head of the agenda restated, in plain words). */
export const MIN_REPLY_WORDS = 7;
const BARE_QUESTION = /^\s*(?:what|what's|whats|so|and|ok|okay|now|next|anything else|what else|how about|hm+)?\s*(?:next|now|else|then|more)?\s*\?\s*$/i;
/** A reply with no substance: fewer than MIN_REPLY_WORDS words with its tokens filled (a token counts as the words it fills), or a bare question such as "What next?". */
export function substanceViolation(text: string, tokens: Readonly<Record<string, string>>): string | null {
  const filled = text.replace(/\{\{([a-zA-Z0-9_.:-]+)\}\}/g, (all, k: string) => (k.startsWith("copy:") ? all : tokens[k] ?? "token"));
  if (BARE_QUESTION.test(filled)) return `a bare question ("${filled.trim()}") with no content — lead with what the loan needs next in plain words`;
  const words = filled.match(/[A-Za-z0-9{][^\s]*/g) ?? [];
  if (words.length < MIN_REPLY_WORDS) return `only ${words.length} word${words.length === 1 ? "" : "s"} ("${filled.trim().slice(0, 80)}") — say what the loan needs next in plain words (at least ${MIN_REPLY_WORDS})`;
  return null;
}

// ---------------------------------------------------------------- (1) provenance: no digit and no spelled-out amount outside a token
const TOKEN = /\{\{[a-zA-Z0-9_.:-]+\}\}/g;
const DIGITS = /\d/;
const SPELLED = /\b(?:hundred|thousand|million|billion|percent|per\s?cent|dollars?|bucks|cents)\b/i;
const NUMBER_WORDS = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b(?:[\s-]+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|point|and))+/i;
export function provenanceViolation(text: string): string | null {
  const bare = text.replace(TOKEN, " ");
  const digit = /\S*\d\S*/.exec(bare); if (digit) return `a raw figure "${digit[0]}" outside a {{token}}`;
  const spelled = SPELLED.exec(bare); if (spelled) return `a spelled-out amount or percentage ("${spelled[0]}") outside a {{token}}`;
  const words = NUMBER_WORDS.exec(bare); if (words) return `a spelled-out number ("${words[0]}") outside a {{token}}`;
  return null;
}

// ---------------------------------------------------------------- (2) compliance: the rates element, the verbatim template
const normalize = (s: string): string => s.toLowerCase().replace(/\*([^*]+)\*/g, "$1").replace(/[“”"']/g, "").replace(/\s+/g, " ").replace(/[.!?…]+\s*$/, "").trim();
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A template with `{{tokens}}` matches any filling; the comparison ignores case, emphasis, quotes and trailing punctuation. */
export function templateMatches(text: string, template: string): boolean {
  const t = normalize(text); if (!t) return false;
  const pattern = "^" + normalize(template).split(/\{\{[a-z0-9_.]+\}\}/).map(escapeRe).join(".+?") + "$";
  return new RegExp(pattern, "i").test(t);
}
/** A template counts only when it has real words of its own (twelve characters outside its tokens): a line that is all tokens matches nothing. */
export function verbatimTemplate(text: string, templates: readonly CopyTemplate[]): CopyTemplate | null {
  for (const tpl of templates) { const literal = normalize(tpl.text).replace(/\{\{[a-z0-9_.]+\}\}/g, "").replace(/\s+/g, " ").trim(); if (literal.length >= 12 && templateMatches(text, tpl.text)) return tpl; }
  return null;
}
const RATES_SENTENCE = /[^.!?]*\b(?:rates?|aprs?)\b[^.!?]*/gi;
const RATES_LEVEL = /\b(?:today'?s|current|published|our|market)\s+(?:\w+[- ]){0,3}rates?\b|\brates?\s+(?:range|start|run|are|go|sit)\b|\bapr\b|\bas low as\b/i;
const NEGATED = /\b(?:not|can'?t|cannot|don'?t|won'?t|no|yet|once|until|after|before|later|when)\b/i;
const OWN_FIGURE = /\{\{(?:numbers|lead|card|proposal)\.[^}]+\}\}|\byour\b/i;
/** The sentence presents a published rate level (not "I can't give a rate yet", not the borrower's own record figure as a token): it needs the rates element beside it. */
export function talksAboutRates(text: string): boolean {
  for (const m of text.matchAll(RATES_SENTENCE)) { const s = m[0]; if (OWN_FIGURE.test(s)) continue; const bare = s.replace(TOKEN, " "); if (RATES_LEVEL.test(bare) && !NEGATED.test(bare)) return true; }
  return false;
}

// ---------------------------------------------------------------- (3) SAFE: the regex baseline (the model backstop is Phase 4's)
const UNDERWRITING = /\b(?:you(?:'re| are| would be| will be|'d be|'ll be)\s+(?:not\s+)?(?:approved|denied|eligible|ineligible|qualified|turned down)|you\s+(?:do(?:n't| not)?\s+|won'?t\s+|will\s+|would\s+|should\s+|might\s+|may\s+|clearly\s+|definitely\s+)?qualify|(?:we|i)\s+can(?:'t|not)?\s+(?:approve|lend|do (?:the|this|your) loan)|\b(?:pre-?)?approv(?:e|ed|al)\b(?!\s+letter)|\bdenied\b|\bdeclin(?:e|ed|es)\b|\bturn(?:ed)?\s+(?:you\s+)?down\b|\bineligible\b|\beligible\b)/i;
/** Negotiation (12 CFR 1008.103(c)(2)(B)): bargaining on terms in the assistant's own voice — matching an offer, waiving or cutting a fee or rate, a discount or a special deal; not the goal question's "lower your rate or payment". */
const NEGOTIATION = /\b(?:i|we)(?:'ll| will| can| could|'d| would|'re able to| are able to)?\s+(?:match|beat)\s+(?:that|their|the|any|your)\s+(?:rate|offer|price|quote)|\b(?:i|we)(?:'ll| will| can| could|'d| would|'m happy to|'re happy to)?\s+(?:waive|lower|reduce|cut|knock|shave|drop)\s+(?:the|your|my|some|a|that)?\s*(?:fee|fees|points|rate|closing costs|price)|\bwaive (?:the|your|that) (?:fee|fees|points)|\bnegotiat|\b(?:a|the|our|special) discount\b|\bspecial (?:deal|rate|pricing)\b|\bthrow in\b/i;
/** Particular terms presented (App. A (b)(2)(iii)): an offer of a rate, APR, payment or points to this borrower — not the word "payment" in a general explanation. */
const PARTICULAR_TERMS = /\b(?:we can offer|we(?:'d| would| could) (?:offer|give|get) you|you(?:'d| would|'ll| will|'re going to| are going to) (?:get|have|pay|see|land at|be at) (?:a |an |the |about |around )?(?:rate|apr|payment|monthly payment|points)|your (?:new |own )?(?:rate|apr|payment|monthly payment) (?:would|will|could|should|is going to|comes to|lands at) (?:be|drop|fall|come|land|around|about)|qualify for our|rate tier|best rate|lock(?:ed)? you in|(?:a|the) rate of|(?:an|the) apr of|for you,? (?:the )?(?:rate|apr|payment) (?:is|would)|i can (?:get|give) you (?:a |an )?(?:rate|apr|payment))\b/i;
/** Data capture (App. A (b)(2)(ii)): the sentence asks the borrower for a fact — an interrogative opening a clause and ending in a question mark. */
const CAPTURE = /(?:^|[.!?]\s+|[—:;]\s*)(?:what|how much|which|when|where|who)\b[^.!?]*\?/i;
const PROCESS = /\b(?:next step|next,|then we|we(?:'ll| will)|the process|takes about|after that|from here)\b/i;
/** The SAFE class of the model's sentence: a regex baseline over App. A (b)(2)'s activities; `proposed` marks a data-capture turn. */
export function classifyUtterance(text: string, o: { proposed: boolean; routed_to: "intake" | "borrower-comms" }): SafeClassification {
  const bare = text.replace(TOKEN, " ");
  if (UNDERWRITING.test(bare)) return "underwriting_communication";
  if (NEGOTIATION.test(bare)) return "negotiation";
  // a serviced loan's own terms are the record's facts, not terms presented for a new loan — the SAFE gate is origination's
  if (o.routed_to === "intake" && PARTICULAR_TERMS.test(bare)) return "particular_terms_presented";
  if (o.proposed || CAPTURE.test(bare)) return "data_capture";
  if (PROCESS.test(bare)) return "process_description";
  return "general_explanation";
}

// ---------------------------------------------------------------- (5) scope, (6) disclosure
const INTERNALS = /\b(?:DU\b|desktop underwriter|findings?\b|credit score|fico|credit report(?:'s)? (?:says|shows|lists|contents?)|tradelines?|fraud|QC\b|quality control|compliance (?:review|check|flag)|risk (?:flag|score|rating)|underwriter(?:'s)? notes?|red flag)/i;
const DECLINE = /\b(?:declin(?:e|ed|es)|denied|deny|turn(?:ed)?\s+(?:you\s+)?down|reject(?:ed)?)\b/i;
export const ASKS_IF_HUMAN = /\b(?:are you|am i (?:talking|chatting|speaking) (?:to|with)|is this)\b[^?]*\b(?:real|human|person|bot|robot|an? ai|automated|machine|computer|live agent)\b/i;
const SAYS_AUTOMATED = /\b(?:automated|not a (?:real )?person|not human|not a human|an? (?:ai|assistant|bot|program|computer)|i'?m (?:an? )?(?:ai|assistant|bot|software)|no,? i'?m not)\b/i;
const OFFERS_PERSON = /\b(?:callback|call (?:you )?back|call back|a person|someone|dispute|case|reach|request|written)\b/i;

export function guardUtterance(i: GuardInput): GuardResult {
  const checks: Record<string, GuardCheck> = {};
  const fail: { by: string; violation: string; regenerable: boolean }[] = [];
  const add = (name: keyof GuardResult["checks"], detail: string | null, regenerable: boolean): void => { checks[name] = { ok: detail === null, detail }; if (detail) fail.push({ by: name, violation: detail, regenerable }); };

  // (4) prohibited inquiries — a hit quarantines the prompt version; never regenerated under the same prompt
  const scan = scanTranscript([{ utterance_id: i.utteranceId, speaker: "agent", text: i.text }], i.promptVersion);
  add("inquiries", scan.findings.length ? `a prohibited inquiry (${scan.findings.map((f) => `${f.code} ${f.citation}: "${f.excerpt}"`).join("; ")})` : null, false);
  // (3) SAFE — the class and the permission the bus gave (21.1 logSafeActivity); gated classes answer with the step's default copy
  add("safe", i.safe.allowed ? null : `${i.classification} is not the assistant's to say${i.safe.reason ? ` (${i.safe.reason})` : ""}; the reply is the step's default copy`, false);
  // (1) provenance
  add("provenance", provenanceViolation(i.text), true);
  // (5) scope — decline language never, internals never, eligibility statements before DU are (3)'s underwriting_communication
  const bare = i.text.replace(TOKEN, " ");
  const decline = DECLINE.exec(bare); const internals = INTERNALS.exec(bare);
  add("scope", decline ? `decline language ("${decline[0]}") is never the assistant's` : internals ? `an internal ("${internals[0]}") the borrower never sees` : null, !decline);
  // (2) compliance — the rates element beside a turn about rates, none of its figures restated, no template verbatim
  const restated = i.ratesElementShown ? i.ratesFigures.find((f) => f && i.text.includes(f)) ?? null : null;
  const tpl = verbatimTemplate(i.text, i.templates);
  add("compliance", tpl ? `the reply is the copy-library template "${tpl.key}" verbatim; say it in your own words` : restated ? `the reply restates a figure of the rates element ("${restated}") — refer to the rates shown here instead` : talksAboutRates(i.text) && !i.ratesElementShown ? "a turn about rates carries the rates element: call explain with topic \"rates\" first, then refer to the rates shown here without a number" : null, true);
  // (6) disclosure — the first row of the session is the disclosure record; "are you a real person?" says it is automated and offers a way to reach a person
  const asked = ASKS_IF_HUMAN.test(i.borrowerText);
  add("disclosure", !i.disclosureFirst ? "the session's first row is not the disclosure record" : asked && !(SAYS_AUTOMATED.test(i.text) && OFFERS_PERSON.test(i.text)) ? "the borrower asked whether you are a person: say plainly that you are automated and offer a callback request, a dispute or a case" : null, asked);
  // (7) substance — a reply under the minimum, or a bare question, says nothing about the next item; regenerated once with the violation named
  add("substance", substanceViolation(i.text, i.tokens), true);

  const first = fail[0] ?? null;
  return { ok: !first, rejected_by: first?.by ?? null, violation: first?.violation ?? null, regenerable: fail.length > 0 && fail.every((f) => f.regenerable), quarantine_prompt_version: scan.quarantine_prompt_version, classification: i.classification, checks: checks as GuardResult["checks"] };
}
