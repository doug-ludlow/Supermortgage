/**
 * Context assembly for the agent turn (docs/ux/17 §3.2, DELTA-23) — rebuilt every turn, nothing carried.
 *
 * The model sees exactly four things, each projected through an allow-list here: the compact `borrower_record` (numbers, dates,
 * names and identifiers replaced by `{{token}}` placeholders the server fills from the record after the guard), the pending cards
 * (kind, copy key, the paths it asks for, the options, an unconfirmed proposal), the last N messages of the channel, and the lead's
 * facts when a lead rode on the cookie. This module imports nothing from DU, credit, fraud, QC or a vendor adapter and reads no other
 * table: it structurally cannot put a DU message, a credit-report field, findings text, a fraud/QC entity or a vendor payload in front
 * of the model (32.16 T2 is the contract test over it). The system prompt is stable (a cached prefix); the situation rides in the
 * user turn; `hash` is the sha256 of both, recorded on `agent_turns.context_hash`.
 */
import { createHash } from "node:crypto";
import type { BorrowerRecord } from "../record.ts";
import type { CardInstanceRow, MessageRow } from "../../../infra/db/borrower-ui.ts";

type P = Record<string, unknown>;
export const PROMPT_VERSION = "32.16-p1";
export const AGENT_TIER = "T2_borrower_facing";
/** The messages of the channel the model sees (docs/ux/17 §3.2: 12 app, 6 SMS, 8 voice). */
export const MESSAGE_WINDOW: Readonly<Record<string, number>> = { app: 12, sms: 6, voice: 8, email: 6 };

// ---------------------------------------------------------------- the system prompt (docs/ux/17 §1 as instructions; 01 §7 plain language)
export const SYSTEM_PROMPT = `You are Supermortgage's automated assistant, working for the partner lender named in the situation. Supermortgage is the self-improving mortgage: it checks every loan against the market every day and, when a refinance would put the borrower ahead, does it. You are talking with a borrower who has an account; the conversation is the whole relationship, from the first message to the last payment.

How to talk: plain words a 13-year-old reads easily, one or two short sentences, one question at a time, no bullet points, no headings, no emoji, no canned phrases. Be warm and quick. Talk in your own words; never repeat a template sentence from the copy library and never restate the automation disclosure (the header carries it). Do not narrate your tools.

The record is the memory and you are stateless: the situation block is rebuilt every turn from the borrower's record, the pending cards and the last few messages. The flows own the agenda: the next step is what session_next says, never your own judgment. Narrate the head of the agenda in your words, answer questions along the way with explain, and bring the borrower back to the current ask.

Figures: you write no digits. Every amount, rate, APR, payment, date, phone number, ID number, name and address in your text is a {{token}} exactly as the situation or a tool gave it (for example {{numbers.rate}} or {{dates.REGZ_1026_19E1_LE_3BD}}); the server fills it from the record. A figure a tool did not give does not exist; if asked, say you do not have it yet and what would produce it. Rates: never state, estimate or compare a rate, an APR or a payment yourself; when today's published rates are wanted, call explain with topic "rates" — the system shows the checked rates element with the APRs and the lender's name and NMLSR ID beside your reply, and you refer to it as "the rates shown here" without restating a number. Personal terms come only after the loan officer of record has reviewed them; before that, say so.

Words never commit; cards do. When the borrower states a fact the current card asks for, call card_propose with the value transcribed as a string (money in cents, choices as the option id) and say what you heard so they can tap Confirm; never calculate, round or infer a value. Consents, credit authorization, declarations and demographics are never taken in words: point to the card. Never say a fact is done because the borrower said it. Ask for nothing except through a card or a tool.

Never: tell the borrower they qualify, are approved, are denied, or are eligible; negotiate a rate, fee or term; mention DU, findings, credit scores, credit-report contents, fraud, QC or compliance reviews; ask about family plans, religion, national origin, race, sex or ancestry; use the words guarantee, guaranteed, pre-approved, approved, denied or lowest.

People: there is no live agent staffed yet. If the borrower asks for a person, say plainly that no one is available live right now and offer what exists: a callback request, a written dispute, or a case, through command_run (callback.schedule, dispute.intake, case.open). Do not offer a transfer as if someone were waiting. If asked whether you are a person: say you are automated and offer the same ways to reach a person. If a tool refuses, tell the borrower simply what happened and do not retry the same call.`;

// ---------------------------------------------------------------- the situation (compact record, cards, messages, lead) — allow-listed projections, figures as tokens
export interface SessionNext { readonly step: "card" | "idle"; readonly card_instance_id: string | null; readonly kind: string | null; readonly copy_key: string | null; readonly why_copy_key: string | null; readonly allowed_answers: readonly P[]; readonly disallowed_topics: readonly string[]; readonly blocking_reason: string | null; readonly waiting_on: readonly P[] }
export interface ContextInput {
  readonly partyFirstName: string;
  readonly level: string;
  readonly channel: string;
  readonly routed_to: "intake" | "borrower-comms";
  readonly safeMode: string;
  readonly partnerName: string;
  readonly record: BorrowerRecord | null;
  readonly cards: readonly CardInstanceRow[];
  readonly messages: readonly MessageRow[];
  readonly lead: P | null;
  readonly next: SessionNext;
  readonly borrowerText: string;
}
export interface AgentContext { readonly system: string; readonly situation: string; readonly tokens: Readonly<Record<string, string>>; readonly hash: string; readonly view: P }

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (v: unknown): string | null => { const s = v === undefined || v === null || v === "" ? null : typeof v === "bigint" ? v.toString() : /^-?\d+$/.test(String(v)) ? String(v) : null; return s === null ? null : USD.format(Number(BigInt(s)) / 100); };
const dateOf = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const short = (id: string): string => id.replace(/-/g, "").slice(0, 8);
const isFigure = (v: unknown): boolean => typeof v === "number" || typeof v === "bigint" || (typeof v === "string" && /\d/.test(v));

/** The `record.numbers` keys the model may know of (02 §4 / record.ts originationNumbers + servicingNumbers): a rate, a percentage, a count — everything else under `numbers` is dropped; `*_cents` keys pass only as money. */
const NUMBER_KEYS: Readonly<Record<string, "rate" | "pct" | "count">> = { note_rate: "rate", rate: "rate", apr: "pct", days_past_due: "count", remaining_term_months: "count", ltv_pct: "pct", dti_pct: "pct" };
/** `record.numbers` → tokens: `numbers.rate` for the note rate, `numbers.<name>` (money) for `*_cents`, `numbers.<key>` for the allow-listed rest — the model sees the keys, never the values; an unlisted key never enters. */
export function numberTokens(numbers: P | null): { view: P; tokens: Record<string, string> } {
  const view: P = {}; const tokens: Record<string, string> = {};
  if (!numbers) return { view, tokens };
  for (const [k, v] of Object.entries(numbers)) {
    if (v === null || v === undefined || v === "" || typeof v === "object") continue;
    let name: string; let value: string | null;
    if (k.endsWith("_cents")) { name = k.slice(0, -"_cents".length); value = money(v); }
    else if (NUMBER_KEYS[k]) { const kind = NUMBER_KEYS[k]!; name = kind === "rate" ? "rate" : k; value = typeof v === "number" || typeof v === "bigint" || /^-?\d+(\.\d+)?$/.test(String(v)) ? (kind === "count" ? String(v) : `${String(v)}%`) : null; }
    else continue;
    if (value === null) continue;
    const key = `numbers.${name}`; tokens[key] = value; view[name] = `{{${key}}}`;
  }
  return { view, tokens };
}

/** The compact record (docs/ux/17 §3.3 `record.get`): status, next, needed/doing, numbers, dates, documents, people, property, loan — figures, dates and names as tokens. */
export function compactRecord(record: BorrowerRecord | null, o: { level: string; partyFirstName: string }): { view: P; tokens: Record<string, string> } {
  const tokens: Record<string, string> = { "party.first_name": o.partyFirstName };
  if (!record) return { view: { subject: null, note: "no application or loan yet: the goal card is the first ask", party: { first_name: "{{party.first_name}}" } }, tokens };
  const view: P = { party: { first_name: "{{party.first_name}}" } };
  view["subject"] = { stage: record.subject.stage, transaction_type: record.subject.transaction_type, occupancy: record.subject.occupancy, has_application: !!record.subject.application_id, has_loan: !!record.subject.loan_id };
  view["status"] = { badge: record.status.badge, one_liner: "{{status.one_liner}}", read_only: record.read_only };
  tokens["status.one_liner"] = record.status.one_liner;
  if (record.next) { view["next"] = { label: record.next.label, timer_code: record.next.timer_code, due_at: "{{next.due_at}}", calendar_note: record.next.calendar_note }; tokens["next.due_at"] = dateOf(record.next.due_at) ?? record.next.due_at; }
  else view["next"] = null;
  view["needed_from_you"] = record.needed_from_you.map((n) => ({ kind: n.kind, label: n.label, card_instance_id: n.card_instance_id, ...(n.due_at ? { due_at: `{{needed.${n.item_id}.due_at}}` } : {}) }));
  for (const n of record.needed_from_you) if (n.due_at) tokens[`needed.${n.item_id}.due_at`] = dateOf(n.due_at) ?? n.due_at;
  view["what_we_are_doing"] = record.what_we_are_doing.map((d) => ({ label: d.label, owner: d.owner, status: d.status }));
  view["needed_summary"] = { count: record.needed_summary.count, nothing_needed: record.needed_summary.nothing_needed };
  // 01 §5 / 32.3 T3: an L1 session's origination record carries no personal terms — the model gets no number tokens either
  const numbers = o.level === "L1" && !record.subject.loan_id ? null : record.numbers;
  const n = numberTokens(numbers); view["numbers"] = Object.keys(n.view).length ? n.view : null; Object.assign(tokens, n.tokens);
  view["dates"] = record.dates.map((d) => ({ label: d.label, timer_code: d.timer_code, status: d.status, due_at: `{{dates.${d.timer_code}}}` }));
  for (const d of record.dates) tokens[`dates.${d.timer_code}`] = dateOf(d.due_at) ?? d.due_at;
  view["documents"] = record.documents.map((d) => ({ document_id: d["document_id"] ?? d["id"] ?? null, class: d["doc_class"] ?? d["class"] ?? d["notice_code"] ?? d["kind"] ?? null, title: typeof d["title"] === "string" && !isFigure(d["title"]) ? d["title"] : null, status: d["status"] ?? null }));
  view["people"] = record.people.map((p, k) => { const role = String(p["role"] ?? `person_${k}`); tokens[`people.${role}.name`] = String(p["name"] ?? p["display_name"] ?? ""); return { role, name: `{{people.${role}.name}}` }; });
  if (record.property) { tokens["property.address"] = String(record.property["address"] ?? record.property["address_line1"] ?? ""); view["property"] = { address: "{{property.address}}", tbd: record.property["tbd"] === true || !tokens["property.address"], state: record.property["state"] ?? null, property_type: record.property["property_type"] ?? null }; }
  else view["property"] = null;
  if (record.loan) {
    const loan = record.loan; const lv: P = {};
    const auto = loan["autodraft"] as P | undefined; if (auto) lv["autodraft"] = { status: auto["status"] ?? null, next_draft_on: auto["next_draft_on"] ? "{{loan.autodraft.next_draft_on}}" : null }; if (auto?.["next_draft_on"]) tokens["loan.autodraft.next_draft_on"] = String(auto["next_draft_on"]);
    for (const k of ["escrowed", "ratewatch_status"]) if (loan[k] !== undefined) lv[k] = loan[k];
    for (const k of ["first_payment_date", "maturity_date"]) if (typeof loan[k] === "string") { tokens[`loan.${k}`] = String(loan[k]); lv[k] = `{{loan.${k}}}`; }
    view["loan"] = lv;
  } else view["loan"] = null;
  view["offers"] = record.offers.length ? record.offers.map((x) => ({ kind: x["kind"] ?? "offer", status: x["status"] ?? null })) : [];
  return { view, tokens };
}

/** The pending cards as the model may know them: the ask, its paths and options, an unconfirmed proposal — field values as tokens (an employer name, a prefilled amount). */
export function compactCards(cards: readonly CardInstanceRow[]): { view: P[]; tokens: Record<string, string> } {
  const tokens: Record<string, string> = {};
  const view = cards.filter((c) => c.status === "pending").map((c) => {
    const props = c.props; const id8 = short(c.card_instance_id);
    const fields = Array.isArray(props["fields"]) ? (props["fields"] as P[]).map((f) => { const path = String(f["path"] ?? ""); const has = f["value"] !== undefined && f["value"] !== null && String(f["value"]) !== ""; if (has) tokens[`card.${id8}.${path}`] = String(f["value"]); return { path, label: typeof f["label"] === "string" ? f["label"] : path, ...(has ? { value: `{{card.${id8}.${path}}}`, source: f["source"] ?? null } : { value: null }), ...(Array.isArray(f["options"]) ? { options: (f["options"] as P[]).map((o) => ({ id: o["id"], label: o["label"] })) } : {}) }; }) : [];
    const options = Array.isArray(props["options"]) ? (props["options"] as P[]).map((o) => ({ id: o["id"], label: o["label"] })) : [];
    const proposal = props["proposal"] && typeof props["proposal"] === "object" ? (props["proposal"] as P) : null;
    return { card_instance_id: c.card_instance_id, kind: c.kind, copy_key: c.copy_key, command_ref: c.command_ref, ...(fields.length ? { fields } : {}), ...(options.length ? { options } : {}), ...(Array.isArray(props["required_paths"]) ? { required_paths: props["required_paths"] } : {}), ...(Array.isArray(props["money_paths"]) ? { money_paths: props["money_paths"] } : {}),
      ...(proposal ? { proposal: { paths: Array.isArray(proposal["fields"]) ? (proposal["fields"] as P[]).map((f) => f["path"]) : [], option_id: proposal["option_id"] ?? null, unconfirmed: true } } : {}), misses: Number(c.misses ?? 0) };
  });
  return { view, tokens };
}

/** The last N messages of the channel: who said what; a copy-library line is shown as its key, never its text (the model must not learn the templates). */
export function compactMessages(rows: readonly MessageRow[], channel: string): P[] {
  const n = MESSAGE_WINDOW[channel] ?? 12;
  return rows.filter((m) => m.channel === channel || m.channel === "app").slice(-n).map((m) => {
    const body = m.body_text ?? ""; const copy = /^\{\{copy:([a-z0-9_.]+)\}\}/.exec(body);
    const text = copy ? `[copy:${copy[1]}]` : body.slice(0, 600);
    return { sender: m.sender, text: m.sender === "system" && !m.body_text ? `[element:${String((m.copy_tokens as P | null)?.["element"] ?? "")}]` : text, ...(m.card_instance_id ? { card_instance_id: m.card_instance_id } : {}) };
  });
}

/** The lead's facts (20.3 rule 6) when a lead rode on the cookie: the goal, the occupancy or contract status, the state; the estimates as tokens. */
export function compactLead(lead: P | null): { view: P | null; tokens: Record<string, string> } {
  const tokens: Record<string, string> = {}; if (!lead) return { view: null, tokens };
  const view: P = {};
  // the facts are the chip answers (20.3 rule 6); a lead opened at the account door carries none ("undecided", no state) and is no lead on the cookie
  for (const k of ["transaction_intent", "occupancy", "contract_status", "consumer_state"]) if (typeof lead[k] === "string" && lead[k] && lead[k] !== "undecided") view[k] = lead[k];
  const est: Record<string, string> = { value_estimate_cents: "home_value", stated_existing_balance_cents: "balance_owed", price_range_cents: "price", down_payment_cents: "down_payment" };
  for (const [k, name] of Object.entries(est)) { const m = money(lead[k]); if (m) { tokens[`lead.${name}`] = m; view[name] = `{{lead.${name}}}`; } }
  return { view: Object.keys(view).length ? view : null, tokens };
}

export function buildContext(i: ContextInput): AgentContext {
  const rec = compactRecord(i.record, { level: i.level, partyFirstName: i.partyFirstName });
  const cards = compactCards(i.cards); const lead = compactLead(i.lead);
  const tokens = { ...rec.tokens, ...cards.tokens, ...lead.tokens };
  const view: P = { lender: i.partnerName, channel: i.channel, assurance_level: i.level, agent: i.routed_to, safe_mode: i.safeMode, record: rec.view, pending_cards: cards.view, session_next: i.next, recent_messages: compactMessages(i.messages, i.channel), ...(lead.view ? { lead_facts: lead.view } : {}), tokens_available: Object.keys(tokens) };
  const situation = JSON.stringify(view, null, 1);
  const borrower = i.borrowerText || (i.messages.some((m) => m.sender === "borrower") ? "(no new message — the borrower is back; restate where things stand and the current ask)" : "(the borrower just created their account and has not said anything yet — greet them by first name and ask the goal in your own words; if lead facts are present, acknowledge them in your words instead of asking again)");
  const hash = createHash("sha256").update(SYSTEM_PROMPT).update("\n").update(situation).digest("hex");
  return { system: SYSTEM_PROMPT, situation: `[situation]\n${situation}\n\n[borrower]\n${borrower}`, tokens, hash, view };
}

/** Fill `{{token}}` placeholders from the record's tokens; an unknown token is dropped (the guard already refused figures outside tokens). */
export function fillTokens(text: string, tokens: Readonly<Record<string, string>>): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const out = text.replace(/\{\{([a-zA-Z0-9_.:-]+)\}\}/g, (all, k: string) => { if (k.startsWith("copy:")) return all; const v = tokens[k]; if (v === undefined) { unknown.push(k); return ""; } return v; }).replace(/[ \t]{2,}/g, " ").trim();
  return { text: out, unknown };
}
