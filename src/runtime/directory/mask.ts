/**
 * 34.2 rule 2 / Verified requirement — masking by role (rule set `directory.mask.v1`). Pure functions; nothing here reads a row.
 *
 *   ops_analyst           names, masked contact (`m…@example.com`, `···0101`), city and state, subjects with last-four identifiers,
 *                         session history (times, doors, levels), consents with kinds and dates — never an SSN or a date of birth.
 *   compliance | officer  the same view, plus — with an active unmask row for their session (unmask.ts) — the full e-mail and phone
 *                         (`contact`) and the SSN last four and the date of birth (`identity`).
 *   nobody                a full SSN, a credential hash, a session token, a vendor payload, the model's raw tool inputs.
 *
 * `MaskLevel` is what the projection is masked for: the role decides whether an unmask may apply at all (ROLE_MASK — an
 * ops_analyst's unmask fields are ignored, never honoured), the unmask rows decide which fields are open.
 */
export type UnmaskField = "contact" | "identity";
export const UNMASK_FIELDS: readonly UnmaskField[] = ["contact", "identity"];
export const isUnmaskField = (v: unknown): v is UnmaskField => v === "contact" || v === "identity";
/** The roles that may hold an unmask (Open question 1: both, with a reason; the log tells them apart). */
export const UNMASK_ROLES: readonly string[] = ["compliance", "officer"];
/** The roles that may read the directory at all (34.1 rule 2: admin manages staff and nothing else that touches a borrower). */
export const DIRECTORY_ROLES: readonly string[] = ["ops_analyst", "officer", "compliance"];
export const EXPORT_ROLES: readonly string[] = ["compliance"];

export interface MaskLevel { readonly contact: boolean; readonly identity: boolean }
export const MASKED: MaskLevel = { contact: false, identity: false };

/** The unmask fields the role may use, as a level: an ops_analyst (or any role outside UNMASK_ROLES) is always fully masked. */
export function maskLevelFor(roles: readonly string[], unmask: readonly string[] = []): MaskLevel {
  if (!roles.some((r) => UNMASK_ROLES.includes(r))) return MASKED;
  return { contact: unmask.includes("contact"), identity: unmask.includes("identity") };
}

/** `maria.garcia@example.com` → `m…@example.com`; a value with no `@` → `…`. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@"); if (at <= 0) return "…";
  return `${email[0]}…${email.slice(at)}`;
}
/** `+16025550101` → `···0101`. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return `···${digits.slice(-4)}`;
}
/** A last-four identifier (`····1234`): loan numbers, application ids, borrower ids on the default view. */
export const lastFour = (v: string | null | undefined): string | null => (v ? `····${String(v).slice(-4)}` : null);

/** NO_FULL_SSN: a nine-digit SSN / ITIN shape anywhere in FREE TEXT (a borrower typing it into the thread) is redacted before it leaves the directory. */
const SSN_RE = /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g;   // every 3-2-4 shape, an ITIN (9xx) included — a phone (10 digits) or a loan number never has this shape
export function redactSsn(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  return text.replace(SSN_RE, "•••-••-••••");
}
/**
 * The generic pass over a projection (stripSecrets): the dashed / spaced 3-2-4 shape only. A bare nine-digit run in a row's
 * value is a cents figure ($1,000,000.00–$9,999,999.99: `upb_cents`, `escrow_balance_cents`, the tape's money facts), a
 * servicer number or a sequence — never an SSN, because no projection selects an SSN column (rule 2: T2 shows the partner's
 * facts as stored). Free-text values (`body_text`, a rationale, a reason) keep the full pass through FREE_TEXT_KEYS.
 */
const SSN_SEPARATED_RE = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g;
export function redactSsnShape(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  return text.replace(SSN_SEPARATED_RE, "•••-••-••••");
}
/** Keys whose string value is a figure or an identifier (a decimal-string cents, a rate, an id, a number, a hash, a sequence): never free text, never redacted. */
const FIGURE_KEY = /(_cents|_bps|_pct|_id|_number|_hash|_no|_last4|last4|sequence|_serial|_count|_ms|_in|_out)$|^(count|sequence|sha256|byte_size)$/;
/** Keys whose value a person may have typed a bare nine-digit SSN into: the full free-text pass (renderBody already takes it for a message body). */
const FREE_TEXT_KEYS: ReadonlySet<string> = new Set(["body_text", "body", "summary", "rationale", "reason", "text", "note", "notes", "detail_text", "message", "description", "title"]);
const redactValue = (key: string | null, v: string): string => (key !== null && FIGURE_KEY.test(key) ? v : key !== null && FREE_TEXT_KEYS.has(key) ? redactSsn(v)! : redactSsnShape(v)!);
/** A masked contact block from a `parties.contact` value (the scalar keys the doors write, the lists a second destination lands in). */
export interface ContactView { email: string | null; phone: string | null; emails: string[]; phones: string[]; city: string | null; state: string | null; unmasked: boolean }
const strs = (v: unknown): string[] => (typeof v === "string" && v ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
export function contactOf(contact: Record<string, unknown>): { emails: string[]; phones: string[]; city: string | null; state: string | null } {
  const emails = [...new Set([...strs(contact["email"]), ...strs(contact["emails"])].map((e) => e.trim().toLowerCase()))];
  const phones = [...new Set([...strs(contact["phone"]), ...strs(contact["phones"]), ...strs(contact["mobile"])])];
  const addr = (contact["address"] ?? contact["mailing_address"]) as Record<string, unknown> | undefined;
  const city = typeof contact["city"] === "string" ? contact["city"] : typeof addr?.["city"] === "string" ? String(addr["city"]) : null;
  const state = typeof contact["state"] === "string" ? contact["state"] : typeof addr?.["state"] === "string" ? String(addr["state"]) : null;
  return { emails, phones, city, state };
}
export function contactView(contact: Record<string, unknown>, level: MaskLevel): ContactView {
  const c = contactOf(contact);
  const email = level.contact ? (e: string) => e : (e: string) => maskEmail(e)!;
  const phone = level.contact ? (p: string) => p : (p: string) => maskPhone(p)!;
  return { email: c.emails[0] ? email(c.emails[0]) : null, phone: c.phones[0] ? phone(c.phones[0]) : null, emails: c.emails.map(email), phones: c.phones.map(phone), city: c.city, state: c.state, unmasked: level.contact };
}
/** The identity block: the SSN last four and the date of birth only when `identity` is open; never a full SSN (the encrypted TIN is never read). */
export function identityView(rows: readonly { tin_last4: string | null; date_of_birth: string | null; source: string }[], level: MaskLevel): { ssn_last4: string | null; date_of_birth: string | null; source: string | null; on_file: boolean; unmasked: boolean } {
  const on = rows.find((r) => r.tin_last4 || r.date_of_birth);
  if (!level.identity || !on) return { ssn_last4: null, date_of_birth: null, source: null, on_file: !!on, unmasked: level.identity };
  return { ssn_last4: on.tin_last4, date_of_birth: on.date_of_birth ? String(on.date_of_birth).slice(0, 10) : null, source: on.source, on_file: true, unmasked: true };
}

/**
 * NO_SECRETS — the keys no directory response may carry, at any depth (a defensive last pass over every projection, on top of
 * the selects that never read them): credential hashes, session tokens, vendor payloads, the model's raw inputs.
 */
export const SECRET_KEYS: ReadonlySet<string> = new Set(["token", "token_hash", "password", "password_hash", "secret", "secret_hash", "tin_encrypted", "ssn", "tin", "context_hash", "args", "args_hash", "raw", "vendor_payload", "vendor_response", "webhook", "public_key_jwk", "credential_id", "email_encrypted", "code_hash", "challenge", "api_key", "authorization"]);
export function stripSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) { if (SECRET_KEYS.has(k)) continue; out[k] = typeof v === "string" ? redactValue(k, v) : stripSecrets(v); }
    return out as T;
  }
  return typeof value === "string" ? (redactValue(null, value) as unknown as T) : value;
}
