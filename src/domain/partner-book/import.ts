/**
 * §33.1 — the partner book import, the pure part (no DB, no clock): the tape and the supplement become a parsed book,
 * every loaded row becomes the baseline-row derivation the platform's readers need, and the party-resolution rule is a
 * function over what exists. src/runtime/partner-book.ts runs this against Postgres in one unit of work; the bus tools in
 * src/app/tools/section33-1.ts plan with it.
 *
 *   readTabular      `.xlsx` through src/infra/files/xlsx.ts (first sheet), `.csv` through the boarding codec's RFC-4180 parser
 *                    (33.1 Integrations: "CSV through the boarding codec's RFC-4180 parser").
 *   parseBook        rule 1 — the profile maps; nothing is refused for being missing. Header presence gates the whole file
 *                    (`rejected` when a required header is absent); a row is skipped only for no loan number / no state / no
 *                    readable balance and rate; a servicer loan number seen twice is a `duplicate_row` (edge cases); the
 *                    supplement joins on the servicer loan number (an orphan is a `supplement_orphan` exception, a row without a
 *                    supplement row is loaded with `gaps: contact`).
 *   deriveLoanRows   rule 2 — what loans / loan_terms / properties carry (the brief's "Rules that bind every write").
 *   resolveParty     rule 3 — link an existing borrower party only on normalized e-mail AND name (last name + first initial);
 *                    the same e-mail with another name is `contact_conflict` and the loan's own party carries no e-mail.
 *   factsEqual       rule 2 — `change = unchanged` when the typed facts (minus the tape's own as-of date) equal the latest row.
 *
 * Never a destination (e-mail / phone) in anything this module returns as a report line: `destinationHash` (sha256 hex) is
 * the only form a destination takes outside `parties.contact` (rule 3 / T4).
 */
import { createHash } from "node:crypto";
import { readXlsx } from "../../infra/files/xlsx.ts";
import { parseCsv } from "../boarding/tape-codec.ts";
import { normalizePhone } from "../../infra/db/borrower-parties.ts";
import { addMonths, plainDate, type PlainDate } from "../../kernel/calendar/date.ts";
import { M3_V1, mapTapeRow, profileHeadersPresent, luhnValidMin, type Fact, type RowException, type TapeProfile } from "./profiles/m3-v1.ts";

export type ParsedFile = { readonly headers: string[]; readonly rows: string[][] };

/** The profiles the importer knows; the operator names one (`profile: "m3-v1"`). */
export const PROFILES: Readonly<Record<string, TapeProfile>> = { "m3-v1": M3_V1 };
export function profileById(id: string): TapeProfile { const p = PROFILES[id]; if (!p) throw new RangeError(`unknown tape profile ${id}; known: ${Object.keys(PROFILES).join(", ")}`); return p; }

export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
/** sha256 hex of the normalized destination — the only form a destination takes in an event, a decision, a report or a log line (rule 3 / T4). */
export const destinationHash = (normalizedDestination: string): string => sha256Hex(`supermortgage:destination:${normalizedDestination}`);

// ───────── files ─────────

const isXlsx = (filename: string, bytes: Uint8Array): boolean => /\.xlsx$/i.test(filename) || (bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04);
const trimRow = (r: readonly string[]): string[] => { const out = [...r]; while (out.length && (out[out.length - 1] ?? "").trim() === "") out.pop(); return out; };

/** A tape or supplement file as a header row and data rows, whichever of `.xlsx` (first sheet) or `.csv` it is. */
export function readTabular(filename: string, bytes: Uint8Array): ParsedFile {
  let rows: string[][];
  if (isXlsx(filename, bytes)) {
    const wb = readXlsx(bytes);
    rows = (wb.sheets[0]?.rows ?? []).map((r) => r.map((c) => c ?? ""));
  } else {
    // The codec's parser keys fields by the header row (a repeated header — the tape carries "Current Occupancy" twice — would
    // collapse), so it runs under a synthetic positional header and the file's own header row comes back as the first data row.
    const text = Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/, "");
    const width = 1024;
    const cols = Array.from({ length: width }, (_, i) => `c${i}`);
    rows = parseCsv(cols.join(",") + "\n" + text).map((r) => cols.map((c) => r[c] ?? ""));
  }
  rows = rows.map(trimRow).filter((r) => r.some((c) => c.trim() !== ""));
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows: rows.map((r) => headers.map((_, i) => r[i] ?? "")) };
}

// ───────── destinations and names ─────────

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
/** A lower-cased, trimmed e-mail; null when the cell is empty or not an address (the channel is dropped — edge cases). */
export function normalizeEmail(s: string | null | undefined): string | null { const t = (s ?? "").trim().toLowerCase(); return t && EMAIL.test(t) ? t : null; }
/** The phone as E.164 through the door's own normalizer (src/infra/db/borrower-parties.ts); null when it does not normalize to +<8–15 digits>. */
export function normalizePhoneE164(s: string | null | undefined): string | null { const t = (s ?? "").trim(); if (!t) return null; const n = normalizePhone(t); return /^\+\d{8,15}$/.test(n) ? n : null; }

const words = (name: string): string[] => name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z\s'-]/g, " ").split(/\s+/).filter((w) => w && !["jr", "sr", "ii", "iii", "iv"].includes(w));
/** Rule 3: the same person by name — last name and first initial, case/whitespace-insensitive ("Maria Garcia" ~ "MARIA  GARCIA", "M. Garcia"). */
export function nameMatches(a: string, b: string): boolean {
  const wa = words(a), wb = words(b);
  if (!wa.length || !wb.length) return false;
  return wa[wa.length - 1] === wb[wb.length - 1] && wa[0]![0] === wb[0]![0];
}
export const firstNameOf = (name: string): string => { const w = name.trim().split(/\s+/).filter(Boolean); return w[0] ?? name.trim(); };
export const lastFour = (servicerLoanNumber: string): string => { const digits = servicerLoanNumber.replace(/\D/g, ""); return (digits.length >= 4 ? digits : servicerLoanNumber).slice(-4).padStart(4, "0"); };

// ───────── the supplement ─────────

export type SupplementRow = {
  readonly row: number;                         // 1-based data row of the supplement
  readonly servicer_loan_number: string;
  readonly email: string | null;                // normalized, or null when absent / malformed
  readonly phone: string | null;                // E.164, or null when absent / not normalizable
  readonly name: string | null;                 // the supplement's borrower_name when the column is present
  readonly tin_last4: string | null;
  readonly date_of_birth: string | null;
  readonly email_dropped: boolean;              // a cell was there but did not normalize
  readonly phone_dropped: boolean;
};

const normKey = (h: string): string => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const SUPPLEMENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  servicer_loan_number: ["servicer_loan_number", "loan_number", "servicer_loan_no", "loan_no", "loan_id"],
  borrower_email: ["borrower_email", "email", "e_mail", "email_address"],
  borrower_phone: ["borrower_phone", "phone", "mobile", "cell", "phone_number", "mobile_phone"],
  borrower_name: ["borrower_name", "name", "borrower"],
  tin_last4: ["tin_last4", "ssn_last4", "ssn_last_4", "last4", "ssn"],
  date_of_birth: ["date_of_birth", "dob", "birth_date"],
};

/** The supplement's rows (servicer_loan_number, borrower_email, borrower_phone, borrower_name?, tin_last4?, date_of_birth?), destinations normalized. */
export function parseSupplement(file: ParsedFile): SupplementRow[] {
  const keys = file.headers.map(normKey);
  const col = (want: string): number => { for (const k of SUPPLEMENT_KEYS[want] ?? [want]) { const i = keys.indexOf(k); if (i >= 0) return i; } return -1; };
  const idx = { loan: col("servicer_loan_number"), email: col("borrower_email"), phone: col("borrower_phone"), name: col("borrower_name"), tin: col("tin_last4"), dob: col("date_of_birth") };
  if (idx.loan < 0) throw new RangeError("the supplement needs a servicer_loan_number column");
  const cell = (r: string[], i: number): string => (i >= 0 ? (r[i] ?? "").trim() : "");
  return file.rows.map((r, k) => {
    const rawEmail = cell(r, idx.email), rawPhone = cell(r, idx.phone);
    const email = normalizeEmail(rawEmail), phone = normalizePhoneE164(rawPhone);
    const tin = cell(r, idx.tin).replace(/\D/g, "").slice(-4);
    const dob = cell(r, idx.dob);
    return { row: k + 1, servicer_loan_number: cell(r, idx.loan), email, phone, name: idx.name >= 0 ? cell(r, idx.name) || null : null,
      tin_last4: tin.length === 4 ? tin : null, date_of_birth: /^\d{4}-\d{2}-\d{2}$/.test(dob) ? dob : null, email_dropped: !!rawEmail && !email, phone_dropped: !!rawPhone && !phone };
  }).filter((s) => s.servicer_loan_number !== "");
}

// ───────── the book ─────────

/**
 * The spec's gap counts (`contact, tin, dob, mailing_address, coborrower, consents, not_on_latest_tape` — Outputs and artifacts) plus the
 * delivery's: `contact_bounced` (Integrations: a bounce) and `invitation_held` (the registry's checklist held the rendered invitation — the
 * ops_analyst's work item). `not_on_latest_tape` (rule 8) counts the partner's monitored loans a later full tape no longer carries — they are
 * never rows of the file, so the count is the plan's (src/app/tools/section33-1.ts planPartnerBook), keyed by servicer loan number in gaps_by_loan.
 */
export type GapKind = "contact" | "tin" | "dob" | "mailing_address" | "coborrower" | "consents" | "not_on_latest_tape" | "contact_bounced" | "invitation_held";
export type GapCounts = Record<GapKind, number>;
export const emptyGaps = (): GapCounts => ({ contact: 0, tin: 0, dob: 0, mailing_address: 0, coborrower: 0, consents: 0, not_on_latest_tape: 0, contact_bounced: 0, invitation_held: 0 });

export type ParsedRow = {
  readonly row: number;                          // 1-based data row of the tape
  readonly servicer_loan_number: string;
  readonly facts: Record<string, Fact>;
  readonly raw: Record<string, string>;
  readonly exceptions: RowException[];
  readonly supplement: SupplementRow | null;
  /** Rule 1 / report: what the partner's file does not carry for this row. */
  readonly gaps: GapKind[];
};
export type ParsedBook = {
  readonly profile: string;
  readonly rejected: { readonly missing_headers: string[] } | null;
  readonly rows_total: number;
  readonly rows: ParsedRow[];                    // the loadable rows, in tape order
  readonly exceptions: RowException[];           // every exception of every row, plus supplement orphans and duplicates
  readonly supplement_rows: number;
};

/** Rule 1 end to end over parsed files: header gate, row mapping, dedup, supplement join and the per-row gaps. */
export function parseBook(profile: TapeProfile, tape: ParsedFile, supplement: ParsedFile | null): ParsedBook {
  const present = profileHeadersPresent(profile, tape.headers);
  if (!present.ok) return { profile: profile.id, rejected: { missing_headers: present.missing }, rows_total: tape.rows.length, rows: [], exceptions: [], supplement_rows: supplement?.rows.length ?? 0 };
  const supp = supplement ? parseSupplement(supplement) : [];
  const suppByLoan = new Map<string, SupplementRow>();
  for (const s of supp) if (!suppByLoan.has(s.servicer_loan_number)) suppByLoan.set(s.servicer_loan_number, s);
  const exceptions: RowException[] = [];
  const rows: ParsedRow[] = [];
  const seen = new Set<string>();
  tape.rows.forEach((r, k) => {
    const rowNo = k + 1;
    const m = mapTapeRow(profile, tape.headers, r, rowNo);
    exceptions.push(...m.exceptions);
    if (m.skip) return;
    const loanNo = String(m.facts[profile.loanNumber]).trim();
    if (seen.has(loanNo)) { exceptions.push({ row: rowNo, servicer_loan_number: loanNo, code: "duplicate_row" }); return; }
    seen.add(loanNo);
    const s = suppByLoan.get(loanNo) ?? null;
    const gaps: GapKind[] = [];
    if (!s || (!s.email && !s.phone)) gaps.push("contact");
    if (!s?.tin_last4) gaps.push("tin");
    if (!s?.date_of_birth) gaps.push("dob");
    gaps.push("mailing_address", "coborrower", "consents");   // the m3-v1 layout carries the property address only, the primary borrower only and no consent evidence
    rows.push({ row: rowNo, servicer_loan_number: loanNo, facts: m.facts, raw: m.raw, exceptions: m.exceptions, supplement: s, gaps });
  });
  for (const s of supp) if (!seen.has(s.servicer_loan_number)) exceptions.push({ row: s.row, servicer_loan_number: s.servicer_loan_number, code: "supplement_orphan", column: "servicer_loan_number" });
  return { profile: profile.id, rejected: null, rows_total: tape.rows.length, rows, exceptions, supplement_rows: supp.length };
}

// ───────── the baseline-row derivation (rule 2; the brief's "Rules that bind every write") ─────────

export type LoanDerivation = {
  readonly loan: { min: string | null; lien: "first" | "second" | "other"; instrument_date: PlainDate; origination_date: PlainDate | null; original_upb_cents: bigint; original_term_months: number; first_payment_date: PlainDate; maturity_date: PlainDate; principal_residence: boolean | null };
  readonly property: { address_line1: string; city: string; state: string; postal_code: string; county: string | null; property_type: string | null; occupancy: string | null; units: number | null };
  readonly terms: { amortization: "fixed" | "arm" | "interest_only" | "balloon"; note_rate_bps: number; pi_cents: bigint; escrow_payment_cents: bigint; escrowed: boolean; interest_method: "30_360"; remittance_type: "A/A" | "S/A" | "S/S"; maturity_date: PlainDate; remaining_term_months: number | null; deferred_principal_cents: bigint;
    arm_index: string | null; arm_margin_bps: number | null; arm_lifetime_cap_bps: number | null; arm_floor_bps: number | null; arm_change_frequency_months: number | null; arm_fixed_period_months: number | null };
  /** The tape's servicing status reduced to a loan status transition, when it names one (edge cases: paid / transferred). */
  readonly status_transition: "paid_off" | "transferred_out" | null;
};

const s = (v: Fact | undefined): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const n = (v: Fact | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const money = (v: Fact | undefined): bigint | null => (typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : null);
const b = (v: Fact | undefined): boolean | null => (typeof v === "boolean" ? v : null);
const date = (v: Fact | undefined): PlainDate | null => { const t = s(v); if (!t) return null; try { return plainDate(t); } catch { return null; } };
/** "7.250" → 72500: the platform's ×10 000 scale for `*_bps` columns (src/runtime/transfers.ts pctToBps(pct, 10_000)). */
export const pctToBps10k = (pct: string | null): number | null => (pct === null ? null : Math.round(Number(pct) * 10_000));
export const monthsBetween = (a: PlainDate, bb: PlainDate): number => (Number(bb.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(bb.slice(5, 7)) - Number(a.slice(5, 7)));

/** The tape's occupancy text → the platform's word ('primary' | 'second_home' | 'investment'), else null. */
export function occupancyOf(text: string | null): "primary" | "second_home" | "investment" | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/^(o|p)$/.test(t) || /owner|primary|principal|occupied/.test(t)) return "primary";
  if (t === "s" || /second|vacation/.test(t)) return "second_home";
  if (t === "i" || /invest|rental|tenant|non[- ]?owner/.test(t)) return "investment";
  return null;
}
/** The agency/remittance text reduced to the enum ('A/A' | 'S/A' | 'S/S'), else A/A (rule 2). */
export function remittanceOf(text: string | null): "A/A" | "S/A" | "S/S" {
  const t = (text ?? "").toUpperCase().replace(/\s+/g, "");
  if (t.includes("S/S")) return "S/S";
  if (t.includes("S/A")) return "S/A";
  return "A/A";
}
export function lienOf(text: string | null): "first" | "second" | "other" {
  const t = (text ?? "").trim().toLowerCase();
  if (!t || /^(1|1st|first)$/.test(t)) return "first";
  if (/^(2|2nd|second)$/.test(t)) return "second";
  return "other";
}
export function unitsOf(propertyType: string | null): number | null {
  const t = (propertyType ?? "").toLowerCase();
  if (!t) return null;
  const m = /(\d)\s*(?:-|to)\s*(\d)\s*unit/.exec(t) ?? /(\d)\s*unit/.exec(t);
  if (m) return Number(m[2] ?? m[1]);
  if (/duplex/.test(t)) return 2; if (/triplex/.test(t)) return 3; if (/fourplex|quadplex/.test(t)) return 4;
  if (/sfr|single|condo|pud|townho|manufactured|detached/.test(t)) return 1;
  return null;
}

export function deriveLoanRows(facts: Record<string, Fact>, asOf: PlainDate): LoanDerivation {
  const originalTerm = n(facts["original_term_months"]) ?? 360;
  const origination = date(facts["origination_date"]);
  const firstPayment = date(facts["first_payment_date"]) ?? (origination ? addMonths(plainDate(`${origination.slice(0, 7)}-01`), 2) : plainDate(`${asOf.slice(0, 7)}-01`));
  const maturity = date(facts["maturity_date"]) ?? addMonths(firstPayment, originalTerm - 1);
  const upb = money(facts["upb_cents"]) ?? 0n;
  const originalUpb = (() => { const o = money(facts["original_upb_cents"]); return o !== null && o > 0n ? o : upb > 0n ? upb : 1n; })();
  const min = s(facts["mers_min"]);
  const occupancy = occupancyOf(s(facts["occupancy"]) ?? s(facts["occupancy_current"]) ?? s(facts["original_occupancy_code"]));
  const ti = money(facts["ti_cents"]) ?? 0n;
  const rate = s(facts["note_rate_pct"]);
  const armIndex = s(facts["arm_index"]);
  const isArm = (!!armIndex && !/^(none|n\/a|na|fixed|no)$/i.test(armIndex)) || (n(facts["arm_fixed_period_months"]) ?? 0) > 0 || /\barm\b|adjustable/i.test(s(facts["loan_type"]) ?? "");
  const amortization: LoanDerivation["terms"]["amortization"] = b(facts["interest_only"]) ? "interest_only" : b(facts["balloon"]) ? "balloon" : isArm ? "arm" : "fixed";
  const nextDue = date(facts["next_due_date"]);
  // rule 2 / worked example A: remaining term = the installments from the as-of date's next due through maturity (loan 1: 2026-10-01 … 2054-10-01 → 337)
  const remaining = nextDue ? monthsBetween(nextDue, maturity) + 1 : n(facts["remaining_term_months"]);
  const propertyType = s(facts["property_type"]) ?? s(facts["property_type_code"]);
  const status = (s(facts["servicing_status"]) ?? "").toLowerCase();
  const status_transition: LoanDerivation["status_transition"] = /paid[\s_-]?(off|in[\s_-]?full)|payoff|liquidat/.test(status) ? "paid_off" : /transfer|service[\s_-]?released|sold/.test(status) ? "transferred_out" : null;
  return {
    loan: { min: min && luhnValidMin(min) ? min : null, lien: lienOf(s(facts["lien_position"])), instrument_date: origination ?? firstPayment, origination_date: origination, original_upb_cents: originalUpb, original_term_months: originalTerm > 0 ? originalTerm : 360,
      first_payment_date: firstPayment, maturity_date: maturity, principal_residence: occupancy === null ? null : occupancy === "primary" },
    property: { address_line1: s(facts["property_address"]) ?? "(unknown)", city: s(facts["property_city"]) ?? "(unknown)", state: (s(facts["property_state"]) ?? "XX").toUpperCase().slice(0, 2), postal_code: (s(facts["property_zip"]) ?? "00000").slice(0, 10), county: s(facts["property_county"]), property_type: propertyType, occupancy: occupancy ?? (s(facts["occupancy"])?.toLowerCase() ?? null), units: unitsOf(propertyType) },
    terms: { amortization, note_rate_bps: pctToBps10k(rate) ?? 0, pi_cents: money(facts["pi_cents"]) ?? 0n, escrow_payment_cents: ti, escrowed: ti > 0n, interest_method: "30_360", remittance_type: remittanceOf(s(facts["agency_remittance_type"])), maturity_date: maturity, remaining_term_months: remaining, deferred_principal_cents: money(facts["deferred_upb_cents"]) ?? 0n,
      arm_index: isArm ? armIndex : null, arm_margin_bps: isArm ? pctToBps10k(s(facts["arm_margin_pct"])) : null, arm_lifetime_cap_bps: isArm ? pctToBps10k(s(facts["arm_rate_ceiling_pct"])) : null, arm_floor_bps: isArm ? pctToBps10k(s(facts["arm_rate_floor_pct"])) : null,
      arm_change_frequency_months: isArm ? n(facts["arm_adj_freq_months"]) : null, arm_fixed_period_months: isArm ? n(facts["arm_fixed_period_months"]) : null },
    status_transition,
  };
}

// ───────── change detection (rule 2) ─────────

/** The typed facts as the record compares them: every key but the tape's own as-of date (a later snapshot with the same figures is `unchanged`). */
export function factsComparable(facts: Record<string, Fact>): Record<string, Fact> { const out: Record<string, Fact> = {}; for (const k of Object.keys(facts).sort()) if (k !== "as_of_date") out[k] = facts[k] ?? null; return out; }
export const factsEqual = (a: Record<string, Fact>, bb: Record<string, Fact>): boolean => JSON.stringify(factsComparable(a)) === JSON.stringify(factsComparable(bb));

// ───────── party resolution (rule 3) ─────────

export type ExistingParty = { readonly id: string; readonly legal_name: string; readonly emails: readonly string[]; readonly phones: readonly string[] };
export type PartyResolution =
  | { readonly kind: "link"; readonly party_id: string; readonly add_phone: string | null }
  | { readonly kind: "create"; readonly email: string | null; readonly phone: string | null; readonly conflict: boolean };

/** The e-mails / phones a `parties.contact` carries (scalar `email`/`phone` — what the door reads — or the list forms). */
export function contactDestinations(contact: Record<string, unknown> | null | undefined): { emails: string[]; phones: string[] } {
  const c = contact ?? {};
  const list = (v: unknown): string[] => (typeof v === "string" && v ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { emails: [...list(c["email"]), ...list(c["emails"])].map((e) => e.trim().toLowerCase()), phones: [...list(c["phone"]), ...list(c["phones"]), ...list(c["mobile"])].map(normalizePhone) };
}

/**
 * Rule 3: an existing borrower party carrying the normalized e-mail AND the same name (last name + first initial) is linked;
 * the same e-mail on a party with another name is a `contact_conflict` and the loan gets its own party without that e-mail
 * (the phone kept) — a party is never linked on an unverified e-mail alone (32.14). `existing` is every borrower party on the
 * platform plus the ones this import created earlier (a household address on two loans: two parties, the second keeps the phone).
 */
export function resolveParty(existing: readonly ExistingParty[], tapeName: string, contact: { email: string | null; phone: string | null }): PartyResolution {
  if (!contact.email) return { kind: "create", email: null, phone: contact.phone, conflict: false };
  const carriers = existing.filter((p) => p.emails.includes(contact.email!));
  if (!carriers.length) return { kind: "create", email: contact.email, phone: contact.phone, conflict: false };
  const same = carriers.find((p) => nameMatches(p.legal_name, tapeName));
  if (same) return { kind: "link", party_id: same.id, add_phone: contact.phone && !same.phones.includes(contact.phone) && same.phones.length === 0 ? contact.phone : null };
  return { kind: "create", email: null, phone: contact.phone, conflict: true };
}

// ───────── the report ─────────

export type ImportLoanLine = { readonly loan_id: string; readonly servicer_loan_number: string; readonly party_id: string | null; readonly change: "created" | "updated" | "unchanged" };
export type ImportReport = {
  readonly profile: string;
  readonly exceptions: RowException[];
  readonly gaps: GapCounts;
  /** Per servicer loan number, the gaps that row carries (never a destination). */
  readonly gaps_by_loan: Record<string, GapKind[]>;
  readonly rejected: { readonly missing_headers: string[] } | null;
  readonly supplement: { readonly rows: number; readonly matched: number; readonly orphans: number };
  readonly loans: ImportLoanLine[];
  /** Rule 8: the partner's monitored loans absent from this later full tape — on hold (`not_on_latest_tape`), never silently closed; `partner_book.loan.not_on_tape` logged per loan. */
  readonly not_on_tape?: { loan_id: string; servicer_loan_number: string; last_as_of_date: string }[];
  /** Per invitation: the party, the loan, the channel and the destination's hash — never the destination; `held_reason` when the checklist held the rendered notice (nothing was sent). */
  readonly invitations: { party_id: string; loan_id: string; channel: "email" | "sms"; destination_hash: string; notice_id: string | null; bounced: boolean; held_reason: string | null }[];
};

/** Distinct tape/supplement rows with at least one exception (the import row's `rows_exception`). */
export function rowsWithExceptions(exceptions: readonly RowException[]): number { return new Set(exceptions.map((e) => `${e.code === "supplement_orphan" ? "s" : "t"}:${e.row}`)).size; }
