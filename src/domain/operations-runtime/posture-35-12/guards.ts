/**
 * §35.12 bus guardrails (AI agent design): pure predicates over (input, ctx) — never a store — refused before anything runs and
 * returned in the CommandRefused shape. POSTURE_IS_OBSERVED refuses an input that asks the platform to change infrastructure
 * (Terraform and IAM change only through the deploy workflow reviewed by people); NO_PII_IN_EVIDENCE refuses a manifest whose
 * `secrets` carries a value-shaped field, before any write; TWO_PERSON_SWITCH / TWO_PERSON_GO_LIVE refuse the input keys that would
 * waive the second person; NO_FAKE_IN_PRODUCTION refuses `mode: fake` for a production switch at the door (the handler refuses it
 * again after `go_live.attested`, rule 4); NO_MONEY_FIELD, NO_CLOCK_EDIT, NO_SELF_ASSERTED_ACTOR and APPROVER_NOT_SELF_ASSERTED are 35.7's.
 */
import { never, str, type ToolInput } from "../../../app/tools.ts";
import { APPROVER_NOT_SELF_ASSERTED, NO_CLOCK_EDIT, NO_SELF_ASSERTED_ACTOR } from "../roles-35-7/guards.ts";
import { arr, isProduction, obj } from "./types.ts";

export { APPROVER_NOT_SELF_ASSERTED, NO_CLOCK_EDIT, NO_SELF_ASSERTED_ACTOR };
/** Rule 11 (35.7 rule 10's regex): an input that names a money field is refused — the drill's `ledger_balanced` flag and `row_checks` are booleans and counts the drill job observed, not figures, and pass. */
const MONEY_RE = /(_cents|amount|balance|upb|payoff|fee|rate|charge|waive|write_?off)/i;
const NOT_MONEY = new Set(["ledger_balanced", "row_checks", "event_chain_ok", "incumbent_file_csv", "incumbent_file_document_id", "rationale"]);
const moneyKey = (i: ToolInput): string | null => { for (const k of [...Object.keys(i), ...Object.keys(obj(i["changes"])), ...Object.keys(obj(i["data"]))]) if (MONEY_RE.test(k) && !NOT_MONEY.has(k)) return k; return null; };
export const NO_MONEY_FIELD = never("NO_MONEY_FIELD", "35.12 rule 11: 'Nothing here touches a borrower's money or identity. Every tool reads the environment and writes its own rows; no ledger line, no `loans` column, no notice'", (i) => moneyKey(i) !== null, "this process observes and reconciles; it never carries a money field — a correction is the owning section's officer command (rule 8)");

/** The keys a secret entry may carry (names and version dates only). Anything else is value-shaped. */
export const SECRET_ENTRY_KEYS: readonly string[] = ["name", "version_created_at", "placeholder", "version"];
const VALUE_KEY_RE = /^(value|payload|plaintext|secret|token|password|key_material|data|contents?)$/i;
/** True when the manifest's `secrets` carries a value-shaped field (a key outside SECRET_ENTRY_KEYS, or a value that looks like a payload). */
export function secretsCarryValue(secrets: unknown): string | null {
  for (const e of arr(secrets)) {
    if (typeof e !== "object" || e === null) return "a secrets entry is not {name, version_created_at, placeholder}";
    for (const k of Object.keys(e as Record<string, unknown>)) if (!SECRET_ENTRY_KEYS.includes(k) || VALUE_KEY_RE.test(k)) return `secrets[].${k} is a value-shaped field`;
    const name = (e as Record<string, unknown>)["name"];
    if (typeof name !== "string" || !name.trim()) return "secrets[].name is required";
    if (/[=:]/.test(name) || name.length > 200) return "secrets[].name is value-shaped";
  }
  return null;
}
/** A value-shaped key anywhere under terraform or runtime (`env: {API_TOKEN: …}`, `password`, `token`, …): the manifest carries names, flags, counts and dates only. */
export function factsCarryValue(v: unknown, path = ""): string | null {
  if (Array.isArray(v)) { for (let k = 0; k < v.length; k++) { const r = factsCarryValue(v[k], `${path}[${k}]`); if (r) return r; } return null; }
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (VALUE_KEY_RE.test(k) || /^(api_token|database_url|env|env_values|environment_variables)$/i.test(k)) return `${path ? path + "." : ""}${k} is a value-shaped field`; const r = factsCarryValue(x, `${path ? path + "." : ""}${k}`); if (r) return r; }
  return null;
}
export const manifestCarriesValue = (i: Record<string, unknown>): string | null => secretsCarryValue(i["secrets"]) ?? factsCarryValue(i["terraform"], "terraform") ?? factsCarryValue(i["runtime"], "runtime");
export const NO_PII_IN_EVIDENCE = never("NO_PII_IN_EVIDENCE", "35.12 Inputs: 'Values only — never a secret''s payload'; T3: 'a manifest whose `secrets` carries a value-shaped field is refused NO_PII_IN_EVIDENCE before any write'", (i) => manifestCarriesValue(i) !== null, "the manifest records secret names, version dates, flags, counts and dates only; a value-shaped field is refused before any row is written");
export const POSTURE_IS_OBSERVED = never("POSTURE_IS_OBSERVED", "35.12 AI agent design: 'it never edits infrastructure (POSTURE_IS_OBSERVED — Terraform and IAM change only through the deploy workflow reviewed by people)'", (i) => ["apply", "terraform_apply", "iam_change", "set_iam", "fix", "remediate", "patch_infrastructure", "gcloud"].some((k) => i[k] !== undefined && i[k] !== false), "the agent observes every environment and never changes infrastructure itself");
export const TWO_PERSON_SWITCH = never("TWO_PERSON_SWITCH", "35.12 rule 4: 'A switch is two people (TWO_PERSON_SWITCH): the ciso requests, compliance confirms the same request_id within 10 minutes'", (i) => ["confirmed", "confirmed_by", "self_confirm", "skip_confirmation", "force", "single_person"].some((k) => i[k] !== undefined && i[k] !== false), "a switch is two people's decision; an input that waives the second person is refused");
export const TWO_PERSON_GO_LIVE = never("TWO_PERSON_GO_LIVE", "35.12 rule 10: 'GL-00 is the attestation: ciso requests, compliance confirms within 10 minutes (TWO_PERSON_GO_LIVE)'", (i) => ["confirmed", "confirmed_by", "self_confirm", "skip_confirmation", "force", "single_person", "attested"].some((k) => i[k] !== undefined && i[k] !== false), "the attestation is two people's decision; an input that waives the second person is refused");
export const NO_FAKE_IN_PRODUCTION = never("NO_FAKE_IN_PRODUCTION", "35.7 rule 6 / 35.12 rule 4: 'a vendor is never FAKE in production'", (i) => isProduction(str(i, "environment")) && str(i, "mode") === "fake" && str(i, "op") !== "confirm", "the FAKE set is empty in production; a production vendor is real or off");
export const NO_REAL_DATA_IN_NONPROD = never("NO_REAL_DATA_IN_NONPROD", "35.12 rule 6: 'No real borrower data in nonprod, no synthetic data in production'", (i) => Object.keys(obj(i["rows"])).length > 0 || i["borrower"] !== undefined || i["tin"] !== undefined || i["email"] !== undefined, "this process reads the environment and writes counts; it never carries a person's row");
export const FINDING_CLOSES_BY_EVIDENCE = never("FINDING_CLOSES_BY_EVIDENCE", "35.12 rule 3: 'a person cannot close a finding by hand' — a finding resolves only by a later manifest's passing check or a 19.2 exception", (i) => ["close", "closed", "status", "action", "resolved", "override"].some((k) => i[k] !== undefined), "a finding is resolved by a manifest's passing check or excepted by an approved 19.2 exception, never by a typed status");
export const COMMON_GUARDS = [NO_SELF_ASSERTED_ACTOR, APPROVER_NOT_SELF_ASSERTED, NO_MONEY_FIELD, NO_CLOCK_EDIT, POSTURE_IS_OBSERVED];
