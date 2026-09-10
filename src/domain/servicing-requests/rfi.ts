/** §4.2 Request for Information — per-item profiles, owner identity, exceptions, redaction. */
import { type PlainDate, addDays, addYears } from "../../kernel/calendar/date.ts";
import { federalDays } from "./clocks.ts";
export type ItemKind = "owner_identity" | "standard";
export function itemDeadlines(kind: ItemKind, receivedOn: PlainDate, state?: string): { ack_due: PlainDate; response_due: PlainDate; extendable: boolean } {
  if (kind === "owner_identity") { const fed = federalDays(receivedOn, 10); const ny = state === "NY" ? addDays(receivedOn, 10) : null; return { ack_due: federalDays(receivedOn, 5), response_due: ny && ny < fed ? ny : fed, extendable: false }; }
  return { ack_due: federalDays(receivedOn, 5), response_due: federalDays(receivedOn, 30), extendable: true };
}
export function extendItem(d: ReturnType<typeof itemDeadlines>, noticeOn: PlainDate): ReturnType<typeof itemDeadlines> | { error: "EXTENSION_NOT_PERMITTED" | "EXTENSION_LATE" } { if (!d.extendable) return { error: "EXTENSION_NOT_PERMITTED" }; if (noticeOn > d.response_due) return { error: "EXTENSION_LATE" }; return { ...d, response_due: federalDays(d.response_due, 15), extendable: false }; }
/**
 * The versioned Fannie Mae owner-identification block (4.2 prerequisites: `reference_contacts.fnma_owner_block`, reviewed at
 * each Guide edition). A4-1-03 (12/20/2023): portfolio loans "Fannie Mae"; MBS loans "Fannie Mae in its capacity as Trustee";
 * both Midtown Center, 1100 15th Street NW, Washington, DC 20005, 1-800-2FANNIE (1-800-232-6643); the six-digit pool number
 * is the trust identifier, given only when the borrower expressly asks for the trust name (comment 36(a)-2).
 */
export const FNMA_OWNER_BLOCK = { version: "A4-1-03 (12/20/2023)", portfolio: "Fannie Mae", mbs: "Fannie Mae in its capacity as Trustee", address: "Midtown Center, 1100 15th Street NW, Washington, DC 20005", phone: "1-800-2FANNIE (1-800-232-6643)" } as const;
export type Ownership = "fnma_portfolio" | "fnma_mbs_trust";
/** The exact A4-1-03 block for the loan's ownership type; the "as of a date certain … may change" sentence is the template's. */
export function ownerIdentity(ownership: Ownership, askedForTrustName = false, poolNumber?: string): string {
  const name = ownership === "fnma_portfolio" ? FNMA_OWNER_BLOCK.portfolio : FNMA_OWNER_BLOCK.mbs;
  const trust = ownership === "fnma_mbs_trust" && askedForTrustName ? ` (trust identifier: Fannie Mae MBS pool ${poolNumber ?? "number available on request"})` : "";
  return `${name}${trust}, ${FNMA_OWNER_BLOCK.address}, ${FNMA_OWNER_BLOCK.phone}`;
}
export function exception(f: { asks_for: "investor_guidelines" | "own_evaluation" | "records" | "call_recordings"; pages_est?: number; hours_est?: number; answered_same_item_within_12m?: boolean; received_on: PlainDate; transfer_out_or_discharge_on?: PlainDate | null }): "irrelevant" | "overbroad" | "duplicative" | "untimely" | null {
  if (f.transfer_out_or_discharge_on && f.received_on > addYears(f.transfer_out_or_discharge_on, 1)) return "untimely";
  if (f.asks_for === "investor_guidelines") return "irrelevant"; if (f.answered_same_item_within_12m) return "duplicative";
  if ((f.pages_est ?? 0) > 5000 || (f.hours_est ?? 0) > 40) return "overbroad"; return null;
}
export function redactions(requester: "borrower" | "confirmed_successor" | "agent"): string[] { return requester === "confirmed_successor" ? ["other_borrowers.location_contact", "other_borrowers.personal_financial"] : requester === "borrower" ? ["successors.personal_data"] : ["non_borrower_data"]; }
/**
 * 4.2 guardrail "must redact per (d)(3) before send (automated PII detector + rule table; a failed redaction check blocks
 * the send)": the rule table per requester names the sections of a response that must be clean —
 * `other_borrower`/`deceased_borrower`/`co_borrower` location/contact and personal financial data for a confirmed
 * successor, `successor`/`successors` personal data for a borrower, non-borrower data for an agent — and, for a
 * potential successor (§1024.36(i)), every account section (nothing but the document description before confirmation).
 * The detector also scans every string under a guarded section for SSN patterns. Loan terms, status and payment history
 * are never redacted for a confirmed successor (§1024.36(d)(3)).
 */
const REDACTION_RULES: Record<string, { readonly section: RegExp; readonly forbid: "pii" | "all"; readonly rule: string }> = {
  confirmed_successor: { section: /^(other|deceased|co)_?borrowers?$/i, forbid: "pii", rule: "other_borrowers" },
  borrower: { section: /^(potential_|confirmed_)?successors?$/i, forbid: "pii", rule: "successors" },
  agent: { section: /^(non_borrower|third_part(y|ies)|other_part(y|ies)|other_borrowers?)/i, forbid: "pii", rule: "non_borrower_data" },
  potential_successor: { section: /^(borrowers?|other_borrowers?|deceased_borrowers?|account|balance|payment_history|payments|status|loan_terms|delinquency|escrow|fees)$/i, forbid: "all", rule: "sii.no_account_info_before_confirmation" },
};
const CONTACT_FIELDS = /^(phone|mobile|email|address|mailing_address|street|city|zip|location|employer)$/i;
const FINANCIAL_FIELDS = /^(ssn|tin|dob|date_of_birth|income|income_cents|assets|assets_cents|bank_account|account_number|credit_score|employment)$/i;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;
const nonEmpty = (v: unknown): boolean => !(v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0));
export function redactionCheck(requester: string, content: unknown): { passed: boolean; violations: { field: string; rule: string }[] } {
  const r = REDACTION_RULES[requester] ?? REDACTION_RULES.agent!;
  const v: { field: string; rule: string }[] = [];
  const walk = (node: unknown, path: string, guarded: boolean): void => {
    if (typeof node === "string") { if (guarded && SSN_PATTERN.test(node)) v.push({ field: path, rule: "pii_detector.ssn_pattern" }); return; }
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((x, n) => walk(x, `${path}[${n}]`, guarded)); return; }
    for (const [k, val] of Object.entries(node as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (!guarded && r.section.test(k)) {
        if (r.forbid === "all") { if (nonEmpty(val)) v.push({ field: p, rule: r.rule }); continue; }
        walk(val, p, true); continue;
      }
      if (guarded && nonEmpty(val) && (CONTACT_FIELDS.test(k) || FINANCIAL_FIELDS.test(k))) { v.push({ field: p, rule: `${r.rule}.${FINANCIAL_FIELDS.test(k) ? "personal_financial" : "location_contact"}` }); continue; }
      walk(val, p, guarded);
    }
  };
  walk(content, "", false);
  return { passed: v.length === 0, violations: v };
}
/** 4.2 rule 3 / guardrail: a `not_available` answer needs a search log covering the mandatory `records_inventory` classes (`online`, `offsite_reasonable`), each with a timestamp. */
export const MANDATORY_SEARCH_CLASSES = ["online", "offsite_reasonable"] as const;
export function searchLogComplete(log: unknown): { complete: boolean; missing: string[] } {
  const rows = Array.isArray(log) ? (log as { availability_class?: unknown; searched_at?: unknown }[]) : [];
  const searched = new Set(rows.filter((x) => typeof x.searched_at === "string" && x.searched_at !== "").map((x) => String(x.availability_class)));
  const missing = MANDATORY_SEARCH_CLASSES.filter((c) => !searched.has(c));
  return { complete: missing.length === 0, missing: [...missing] };
}
/** 4.2 rule 4 / comment 36(f)(1)(iii)-1: the borrower's own evaluation inputs and results, account and payment records are relevant — never `irrelevant`. */
export function ownAccountRecord(description: string): boolean { return /\b(my|our|the borrower'?s?|borrower'?s) (own )?(evaluation|application|account|payment|escrow|loan|file|history|records?)/i.test(description); }
/** §1024.36(d)(3): what a confirmed successor's payment-history response keeps (loan terms, status, history) and drops (the other borrower's location/contact and personal financial data). */
export function redactForSuccessor<T extends Record<string, unknown>>(history: T, otherBorrower: { ssn?: string; phone?: string; email?: string; address?: string; income_cents?: bigint; [k: string]: unknown }): { response: T & { other_borrower: Record<string, never> }; redaction_log: { field: string; rule: string }[] } {
  const log = Object.keys(otherBorrower).map((field) => ({ field: `other_borrower.${field}`, rule: /ssn|income|financial|account/.test(field) ? "other_borrowers.personal_financial" : "other_borrowers.location_contact" }));
  return { response: { ...history, other_borrower: {} }, redaction_log: log };
}
