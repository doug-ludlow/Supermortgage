/**
 * §35.5 rule 9 — the per-loan servicing configuration (`loan_servicing_configs`) and the effective-dated servicer profile
 * (`servicer_profiles`) that replace the two runtime constants (`LOAN_LOCAL_TZ`, `SERVICER_CONTACT`), rule set `35.5@config.v1`.
 *
 *   STATE_DEFAULT_TIME_ZONE       the reviewed state → IANA zone map (split-zone states take the majority zone; SPLIT_ZONE_STATES lists them
 *                                 — a county override or a manual `compliance` row is the loan's, never a guess).
 *   FAKE_SERVICER_PROFILE_V1      the former SERVICER_CONTACT values — the FAKE build's seeded `servicer_profiles` version 1 (0143); the
 *                                 constants the staff and partner-book notices print derive from it until `compliance` activates v2.
 *   projectServicingConfig(…)     at `loan.boarded` in the boarding transaction: time zone from the state map (state_default), jurisdiction,
 *                                 the active profile, 2.7's lateChargeTerms against jurisdiction_rules.rules.late_charge, nsf_fee_allowed;
 *                                 `loan.servicing_config.written` satisfies SM_LOAN_SERVICING_CONFIG_AT_BOARD_0; refuses CONFIG_REQUIRED.
 *   servicingConfigFor(db, …)     the latest row by effective_from ≤ as-of; no row → CommandRefused CONFIG_REQUIRED (never a default zone).
 *   loanLocalDate(cfg, instant)   wallClock(instant, cfg.time_zone).date — every loan-local civil date.
 *   servicerBlockFor(db, …)       the servicer block every notice renders (name, TIN, phone, addresses, URLs) from the profile in force on the
 *                                 notice date for the loan's servicing party; no profile in force → CONFIG_REQUIRED ("notices refuse to render").
 *   activateServicerProfile(…)    `servicer_profile.write{op: activate}` by `compliance`: the new version's row, the prior version closed
 *                                 (effective_to, superseded), `servicer_profile.activated{…, decision_id}`.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../infra/db/client.ts";
import { toJson } from "../../infra/db/client.ts";
import { PgDecisionRepository, type DecisionInput } from "../../infra/db/decisions.ts";
import { CommandRefused, type CommandContext } from "../../app/commands.ts";
import { str, type ToolInput, type ToolRuntime } from "../../app/tools.ts";
import type { Actor, DomainEvent } from "../../kernel/events/index.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { lateChargeTerms } from "../cashiering/latecharges.ts";
import { armServicingSideClocks } from "./timers-35-5.ts";
import { CASHIERING_AGENT, MODEL_VERSION_DETERMINISTIC, PROMPT_VERSION_35_5, type BoardingProjectionContext, type BoardingProjectionDeps } from "./installments.ts";

export const RULE_SET_CONFIG = "35.5@config.v1";
export const CONFIG_WRITTEN = "loan.servicing_config.written";
export const PROFILE_ACTIVATED = "servicer_profile.activated";
const LOAN_BOARDED = "loan.boarded";
const c = (v: unknown): Cents => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v)));
function refuse(command: string, code: string, citation: string, reason: string): never { throw new CommandRefused(command, code, citation, reason); }

// ---------------------------------------------------------------- the reviewed state → default time zone map
/** Split-zone states (the spec's prerequisite list): the map carries the majority zone; a county override or a manual `compliance` row is the loan's. */
export const SPLIT_ZONE_STATES: readonly string[] = ["AZ", "ID", "OR", "NE", "KS", "ND", "SD", "TX", "TN", "KY", "FL", "MI", "IN"];
export const STATE_DEFAULT_TIME_ZONE: Readonly<Record<string, string>> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago", CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York", DC: "America/New_York",
  FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu", ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York",
  LA: "America/Chicago", ME: "America/New_York", MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago", MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver",
  NE: "America/Chicago", NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York", SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver",
  VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles", WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver",
};

// ---------------------------------------------------------------- the FAKE servicer profile (= migration 0143's version 1)
/** The former `SERVICER_CONTACT` (src/runtime/servicing.ts at HEAD) plus the profile columns: the authored samples' values — never a real address, number or EIN. Identical to 0143's seeded row (35.5-T13 asserts it). */
export const FAKE_SERVICER_PROFILE_V1 = {
  legal_name: "Supermortgage LLC", dba: null, nmls_id: "FAKE-000000", tin: "12-3456789", toll_free_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001", exclusive_address: "PO Box 2, Testville TX 75001",
  remittance_address: "Supermortgage, PO Box 7, Testville TX 75001", payment_requirements_version: "SM-PR-v1", portal_url: "https://portal.example.com/statements", counselor_url: "consumerfinance.gov/find-a-housing-counselor", hud_phone: "(800) 569-4287",
  hours: "Mon-Fri 08:00-20:00 ET", languages: ["en", "es"] as readonly string[], version: 1, effective_from: "2020-01-01",
  // the aliases the notice payloads spell (servicing.ts's former constant): the same values under the block's field names
  servicer_name: "Supermortgage LLC", servicer_tin: "12-3456789", servicer_phone: "(800) 555-0100",
} as const;

export interface ServicerProfileRow {
  readonly id: string; readonly servicing_party_id: string; readonly version: number; readonly effective_from: PlainDate; readonly effective_to: PlainDate | null; readonly legal_name: string; readonly dba: string | null; readonly nmls_id: string | null; readonly tin: string | null;
  readonly toll_free_phone: string; readonly servicer_address: string; readonly exclusive_address: string; readonly remittance_address: string; readonly payment_requirements_version: string | null; readonly portal_url: string; readonly counselor_url: string; readonly hud_phone: string;
  readonly hours: string | null; readonly languages: readonly string[]; readonly status: "draft" | "active" | "superseded"; readonly approved_by_decision_id: string | null;
}
type Raw = Record<string, unknown>;
const profileOf = (r: Raw): ServicerProfileRow => ({ id: String(r.id), servicing_party_id: String(r.servicing_party_id), version: Number(r.version), effective_from: D(String(r.effective_from)), effective_to: r.effective_to ? D(String(r.effective_to)) : null, legal_name: String(r.legal_name), dba: (r.dba as string | null) ?? null, nmls_id: (r.nmls_id as string | null) ?? null, tin: (r.tin as string | null) ?? null,
  toll_free_phone: String(r.toll_free_phone), servicer_address: String(r.servicer_address), exclusive_address: String(r.exclusive_address), remittance_address: String(r.remittance_address), payment_requirements_version: (r.payment_requirements_version as string | null) ?? null, portal_url: String(r.portal_url), counselor_url: String(r.counselor_url), hud_phone: String(r.hud_phone),
  hours: (r.hours as string | null) ?? null, languages: Array.isArray(r.languages) ? (r.languages as string[]) : [], status: String(r.status) as ServicerProfileRow["status"], approved_by_decision_id: (r.approved_by_decision_id as string | null) ?? null });
const PROFILE_COLS = "id, servicing_party_id, version, effective_from::text AS effective_from, effective_to::text AS effective_to, legal_name, dba, nmls_id, tin, toll_free_phone, servicer_address, exclusive_address, remittance_address, payment_requirements_version, portal_url, counselor_url, hud_phone, hours, languages, status, approved_by_decision_id";

/** The platform's own servicing party (0143: party_type servicer, legal_name 'Supermortgage LLC', no servicer number). */
export async function platformServicingPartyId(q: Queryable): Promise<string | null> {
  return (await q.query<{ id: string }>(`SELECT id FROM parties WHERE party_type = 'servicer' AND legal_name = 'Supermortgage LLC' AND servicer_number IS NULL ORDER BY created_at LIMIT 1`))[0]?.id ?? null;
}
/** The profile version in force on `asOf` for the party: effective_from ≤ asOf < effective_to over the active and superseded versions (a superseded row is the version that was in force before its successor's effective date). */
export async function activeServicerProfile(q: Queryable, partyId: string, asOf: PlainDate): Promise<ServicerProfileRow | null> {
  const r = (await q.query<Raw>(`SELECT ${PROFILE_COLS} FROM servicer_profiles WHERE servicing_party_id = $1 AND status IN ('active', 'superseded') AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to > $2::date) ORDER BY version DESC LIMIT 1`, [partyId, asOf]))[0];
  return r ? profileOf(r) : null;
}
export async function servicerProfileById(q: Queryable, id: string): Promise<ServicerProfileRow | null> {
  const r = (await q.query<Raw>(`SELECT ${PROFILE_COLS} FROM servicer_profiles WHERE id = $1`, [id]))[0];
  return r ? profileOf(r) : null;
}

// ---------------------------------------------------------------- jurisdiction_rules (0002:135), read never written here
export interface JurisdictionRules { readonly state: string; readonly licensed: boolean; readonly nsf_fee: { readonly allowed: boolean; readonly cap_cents: Cents | null }; readonly late_charge: { readonly max_pct: string; readonly min_grace_days: number } | null; }
export async function jurisdictionRulesFor(q: Queryable, state: string): Promise<JurisdictionRules | null> {
  const r = (await q.query<{ state: string; licensed: boolean; rules: Raw }>(`SELECT state, licensed, rules FROM jurisdiction_rules WHERE state = $1`, [state]))[0];
  if (!r) return null;
  const rules = r.rules ?? {}; const nsf = (rules.nsf_fee as Raw | undefined) ?? {}; const lc = rules.late_charge as Raw | undefined;
  return { state: r.state, licensed: r.licensed, nsf_fee: { allowed: nsf.allowed !== false, cap_cents: nsf.cap_cents === undefined || nsf.cap_cents === null ? null : c(nsf.cap_cents) }, late_charge: lc && typeof lc.max_pct === "string" ? { max_pct: lc.max_pct, min_grace_days: Number(lc.min_grace_days ?? 0) } : null };
}

// ---------------------------------------------------------------- rule 9 at boarding
export interface ServicingConfigFacts { readonly loan_id: string; readonly state: string | null; readonly late_charge_pct: string; readonly late_charge_grace_days: number; readonly effective_from: PlainDate; readonly lockbox_id?: string | null; }
export interface ServicingConfigRow {
  readonly id: string; readonly loan_id: string; readonly effective_from: PlainDate; readonly time_zone: string; readonly time_zone_source: "state_default" | "county_override" | "borrower_stated" | "manual"; readonly jurisdiction_state: string; readonly servicer_profile_id: string;
  readonly lockbox_id: string | null; readonly channels_enabled: readonly string[]; readonly late_charge_terms: ReturnType<typeof lateChargeTerms>; readonly nsf_fee_allowed: boolean; readonly written_by: Record<string, unknown>; readonly decision_id: string | null;
}
export interface ProjectedConfig { readonly config: ServicingConfigRow; readonly decision_id: string; readonly decision: DecisionInput; readonly event: DomainEvent; }
export const DEFAULT_LOCKBOX_ID = "LBX-1";
export const DEFAULT_CHANNELS: readonly string[] = ["lockbox", "ach_debit_origin", "portal_onetime"];

/** The config row's facts from the state, the jurisdiction row and the profile: the pure part of rule 9 (also `servicing_config.write`'s defaults). */
export function configFrom(f: { loan_id: string; state: string; late_charge_pct: string; late_charge_grace_days: number; effective_from: PlainDate; lockbox_id?: string | null; time_zone?: string | null; time_zone_source?: ServicingConfigRow["time_zone_source"]; servicer_profile_id?: string | null }, j: JurisdictionRules, profile: ServicerProfileRow, writtenBy: Record<string, unknown>): ServicingConfigRow {
  const tz = f.time_zone ?? STATE_DEFAULT_TIME_ZONE[f.state] ?? null;
  if (!tz) refuse("servicing_config.write", "CONFIG_REQUIRED", "35.5 rule 9: the boarding never guesses a time zone", `no reviewed default time zone for state ${f.state}`);
  return { id: randomUUID(), loan_id: f.loan_id, effective_from: f.effective_from, time_zone: tz, time_zone_source: f.time_zone ? (f.time_zone_source ?? "manual") : "state_default", jurisdiction_state: f.state, servicer_profile_id: f.servicer_profile_id ?? profile.id, lockbox_id: f.lockbox_id ?? DEFAULT_LOCKBOX_ID, channels_enabled: [...DEFAULT_CHANNELS],
    late_charge_terms: lateChargeTerms({ pct: f.late_charge_pct, grace_days: f.late_charge_grace_days }, j.late_charge ? { max_pct: j.late_charge.max_pct, min_grace_days: j.late_charge.min_grace_days, state: j.state } : null), nsf_fee_allowed: j.nsf_fee.allowed, written_by: writtenBy, decision_id: null };
}

/** Rule 9 inside the boarding transaction: the row projected (persisted by `insertServicingConfig` in the same transaction), `loan.servicing_config.written` on the log (SM_LOAN_SERVICING_CONFIG_AT_BOARD_0 armed explicitly on the transfer path), the decision prepared. Refuses CONFIG_REQUIRED. */
export async function projectServicingConfig(q: Queryable, ctx: BoardingProjectionContext, f: ServicingConfigFacts, deps: BoardingProjectionDeps): Promise<ProjectedConfig> {
  const command = "servicing_config.write";
  if (!f.state) refuse(command, "CONFIG_REQUIRED", "35.5 rule 9: jurisdiction_state = properties.state", `loan ${f.loan_id}: the property has no state`);
  const j = await jurisdictionRulesFor(q, f.state);
  if (!j) refuse(command, "CONFIG_REQUIRED", "35.5 rule 9: jurisdiction_rules is read, never written, here", `loan ${f.loan_id}: no jurisdiction_rules row for ${f.state}`);
  const party = await platformServicingPartyId(q);
  const profile = party ? await activeServicerProfile(q, party, f.effective_from) : null;
  if (!profile) refuse(command, "CONFIG_REQUIRED", "35.5 rule 9: servicer_profile_id = the active servicer_profiles row of the servicing party", `no active servicer profile on ${f.effective_from} (seed 0143 or activate one through servicer_profile.write)`);
  const config = configFrom({ loan_id: f.loan_id, state: f.state, late_charge_pct: f.late_charge_pct, late_charge_grace_days: f.late_charge_grace_days, effective_from: f.effective_from, lockbox_id: f.lockbox_id ?? null }, j, profile, { actor: `${CASHIERING_AGENT.kind}:${CASHIERING_AGENT.id}`, at: "boarding", split_zone_state: SPLIT_ZONE_STATES.includes(f.state) });
  const boarded = ctx.events.byLoan(f.loan_id).filter((e) => e.type === LOAN_BOARDED).at(-1);
  if (boarded) armServicingSideClocks(ctx.timers, deps.registry, boarded, ["SM_LOAN_SERVICING_CONFIG_AT_BOARD_0"]);
  const decision_id = randomUUID();
  const event = ctx.events.append({ type: CONFIG_WRITTEN, loanId: f.loan_id, actor: CASHIERING_AGENT, ...(boarded ? { causationId: boarded.id } : {}),
    payload: { loan_id: f.loan_id, config_id: config.id, time_zone: config.time_zone, time_zone_source: config.time_zone_source, jurisdiction_state: config.jurisdiction_state, servicer_profile_id: config.servicer_profile_id, servicer_profile_version: profile.version, effective_from: config.effective_from, late_charge_terms: config.late_charge_terms, nsf_fee_allowed: config.nsf_fee_allowed, decision_id } });
  const record = { loan_id: f.loan_id, action: "servicing_config.write", inputs: { state: f.state, note: { pct: f.late_charge_pct, grace_days: f.late_charge_grace_days }, jurisdiction: j, profile_version: profile.version }, outputs: { config_id: config.id, time_zone: config.time_zone, time_zone_source: config.time_zone_source, late_charge_terms: config.late_charge_terms, nsf_fee_allowed: config.nsf_fee_allowed }, rule_set_version: RULE_SET_CONFIG, model_version: MODEL_VERSION_DETERMINISTIC, prompt_version: PROMPT_VERSION_35_5, confidence: 1 };
  const decision: DecisionInput = { agent: CASHIERING_AGENT.id, action: "servicing_config.write", rationale: toJson(record), ruleSetVersion: RULE_SET_CONFIG, loanId: f.loan_id, subject: { kind: "loan_servicing_config", id: config.id }, ...(config.late_charge_terms.conflict ? { ruleCode: "LATE_CHARGE_STATE_CAP" } : {}), confidence: 1, modelVersion: MODEL_VERSION_DETERMINISTIC, promptVersion: PROMPT_VERSION_35_5 };
  return { config: { ...config, decision_id }, decision_id, decision, event };
}

/** One `loan_servicing_configs` row (the decision first when the projection prepared one). */
export async function insertServicingConfig(q: Queryable, cfg: ServicingConfigRow): Promise<void> {
  await q.query(`INSERT INTO loan_servicing_configs (id, loan_id, effective_from, time_zone, time_zone_source, jurisdiction_state, servicer_profile_id, lockbox_id, channels_enabled, late_charge_terms, nsf_fee_allowed, written_by, decision_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::jsonb, $11, $12::jsonb, $13)`,
    [cfg.id, cfg.loan_id, cfg.effective_from, cfg.time_zone, cfg.time_zone_source, cfg.jurisdiction_state, cfg.servicer_profile_id, cfg.lockbox_id, [...cfg.channels_enabled], toJson(cfg.late_charge_terms), cfg.nsf_fee_allowed, toJson(cfg.written_by), cfg.decision_id]);
}
export async function persistProjectedConfig(q: Queryable, decisions: PgDecisionRepository, p: ProjectedConfig): Promise<void> {
  await decisions.record(p.decision, q, p.decision_id);
  await insertServicingConfig(q, p.config);
}

// ---------------------------------------------------------------- the config in force
const CONFIG_COLS = "id, loan_id, effective_from::text AS effective_from, time_zone, time_zone_source, jurisdiction_state, servicer_profile_id, lockbox_id, channels_enabled, late_charge_terms, nsf_fee_allowed, written_by, decision_id";
const configOf = (r: Raw): ServicingConfigRow => ({ id: String(r.id), loan_id: String(r.loan_id), effective_from: D(String(r.effective_from)), time_zone: String(r.time_zone), time_zone_source: String(r.time_zone_source) as ServicingConfigRow["time_zone_source"], jurisdiction_state: String(r.jurisdiction_state), servicer_profile_id: String(r.servicer_profile_id),
  lockbox_id: (r.lockbox_id as string | null) ?? null, channels_enabled: Array.isArray(r.channels_enabled) ? (r.channels_enabled as string[]) : [], late_charge_terms: r.late_charge_terms as ServicingConfigRow["late_charge_terms"], nsf_fee_allowed: r.nsf_fee_allowed === true, written_by: (r.written_by as Record<string, unknown>) ?? {}, decision_id: (r.decision_id as string | null) ?? null });
/** The latest row by effective_from ≤ asOf, or undefined. */
export async function servicingConfigIfAny(q: Queryable, loanId: string, asOf: PlainDate): Promise<ServicingConfigRow | undefined> {
  const r = (await q.query<Raw>(`SELECT ${CONFIG_COLS} FROM loan_servicing_configs WHERE loan_id = $1 AND effective_from <= $2::date ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [loanId, asOf]))[0];
  return r ? configOf(r) : undefined;
}
/** Rule 9: a read with no config row is a typed refusal, never a default zone. */
export async function servicingConfigFor(q: Queryable, loanId: string, asOf: PlainDate): Promise<ServicingConfigRow> {
  const cfg = await servicingConfigIfAny(q, loanId, asOf);
  if (!cfg) refuse("cashiering.run_unit", "CONFIG_REQUIRED", "35.5 rule 9: no loan-local date without a config row", `loan ${loanId} has no loan_servicing_configs row effective on ${asOf}`);
  return cfg;
}
/** The loan-local civil date of an instant. */
export const loanLocalDate = (cfg: Pick<ServicingConfigRow, "time_zone">, instant: string): PlainDate => wallClock(Date.parse(instant), cfg.time_zone).date;

// ---------------------------------------------------------------- the servicer block every notice renders
export interface ServicerBlock { readonly servicer_name: string; readonly servicer_tin: string; readonly servicer_phone: string; readonly servicer_address: string; readonly exclusive_address: string; readonly remittance_address: string; readonly portal_url: string; readonly counselor_url: string; readonly hud_phone: string; readonly servicer_profile_id: string; readonly servicer_profile_version: number; }
export const blockOf = (p: ServicerProfileRow): ServicerBlock => ({ servicer_name: p.legal_name, servicer_tin: p.tin ?? "", servicer_phone: p.toll_free_phone, servicer_address: p.servicer_address, exclusive_address: p.exclusive_address, remittance_address: p.remittance_address, portal_url: p.portal_url, counselor_url: p.counselor_url, hud_phone: p.hud_phone, servicer_profile_id: p.id, servicer_profile_version: p.version });
/**
 * The servicer identity in force on `asOf` for the loan: the profile version of the loan's configured servicing party (its config row's
 * profile → that profile's party), else — a loan boarded before rule 9 wrote configs (fixtures, partner-book imports) — the platform's own
 * party; no version in force on the date → CONFIG_REQUIRED (the spec's "notices refuse to render").
 */
export async function servicerBlockFor(q: Queryable, loanId: string, asOf: PlainDate): Promise<ServicerBlock> {
  const cfg = await servicingConfigIfAny(q, loanId, asOf);
  const configured = cfg ? await servicerProfileById(q, cfg.servicer_profile_id) : null;
  const party = configured?.servicing_party_id ?? (await platformServicingPartyId(q));
  const profile = party ? await activeServicerProfile(q, party, asOf) : null;
  if (!profile) refuse("notice.render", "CONFIG_REQUIRED", "35.5 rule 9 / edge cases: the active servicer_profiles row expires with no successor → notices refuse to render", `no servicer profile in force on ${asOf} for loan ${loanId}`);
  return blockOf(profile);
}

// ---------------------------------------------------------------- servicer_profile.write
export interface ProfileDraft { readonly servicing_party_id: string; readonly version: number; readonly effective_from: PlainDate; readonly effective_to?: PlainDate | null; readonly legal_name: string; readonly dba?: string | null; readonly nmls_id?: string | null; readonly tin?: string | null; readonly toll_free_phone: string; readonly servicer_address: string; readonly exclusive_address: string; readonly remittance_address: string; readonly payment_requirements_version?: string | null; readonly portal_url: string; readonly counselor_url: string; readonly hud_phone: string; readonly hours?: string | null; readonly languages?: readonly string[]; readonly status: "draft" | "active"; readonly approved_by_decision_id?: string | null; }
/** One `servicer_profiles` row (draft, or the active row of a new version). */
export async function insertServicerProfile(q: Queryable, p: ProfileDraft, id: string = randomUUID()): Promise<string> {
  await q.query(`INSERT INTO servicer_profiles (id, servicing_party_id, version, effective_from, effective_to, legal_name, dba, nmls_id, tin, toll_free_phone, servicer_address, exclusive_address, remittance_address, payment_requirements_version, portal_url, counselor_url, hud_phone, hours, languages, status, approved_by_decision_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::text[], $20, $21)`,
    [id, p.servicing_party_id, p.version, p.effective_from, p.effective_to ?? null, p.legal_name, p.dba ?? null, p.nmls_id ?? null, p.tin ?? null, p.toll_free_phone, p.servicer_address, p.exclusive_address, p.remittance_address, p.payment_requirements_version ?? null, p.portal_url, p.counselor_url, p.hud_phone, p.hours ?? null, [...(p.languages ?? ["en"])], p.status, p.approved_by_decision_id ?? null]);
  return id;
}
/** The activation write: the prior active version closed at the new effective date (status superseded — the only UPDATE the table allows), the new version's active row. */
export async function activateServicerProfile(q: Queryable, next: ProfileDraft & { status: "active" }, id: string = randomUUID()): Promise<string> {
  await q.query(`UPDATE servicer_profiles SET effective_to = $2::date, status = 'superseded' WHERE servicing_party_id = $1 AND status = 'active' AND effective_from < $2::date AND (effective_to IS NULL OR effective_to > $2::date)`, [next.servicing_party_id, next.effective_from]);
  await q.query(`UPDATE servicer_profiles SET status = 'superseded' WHERE servicing_party_id = $1 AND status = 'active' AND effective_from >= $2::date`, [next.servicing_party_id, next.effective_from]);
  return insertServicerProfile(q, next, id);
}

type Services = { db?: Queryable; deferWrite?: (fn: (q: Queryable) => Promise<void>) => void };
const need = (i: ToolInput, k: string): string => { const v = str(i, k); if (!v) throw new RangeError(`${k} is required`); return v; };
const dbOf = (rt: ToolRuntime): Queryable => { const db = (rt.services as Services).db; if (!db) throw new RangeError("35.5 config tools need the runtime's database (services.db)"); return db; };
const deferOf = (rt: ToolRuntime): ((fn: (q: Queryable) => Promise<void>) => void) => { const d = (rt.services as Services).deferWrite; if (!d) throw new RangeError("35.5 config tools need the command's deferred write (services.deferWrite)"); return d; };
const PROFILE_FIELDS = ["legal_name", "dba", "nmls_id", "tin", "toll_free_phone", "servicer_address", "exclusive_address", "remittance_address", "payment_requirements_version", "portal_url", "counselor_url", "hud_phone", "hours"] as const;
const actorText = (a: Actor): string => `${a.kind}:${a.id}${a.role ? ` (${a.role})` : ""}`;

/**
 * `servicing_config.write{loan_id, time_zone?, jurisdiction_state?, servicer_profile_id?, time_zone_source?, reason?}`: a new effective-dated
 * row — the agent writes the defaults (state map, active profile); an explicit time zone or profile is `compliance`'s (guardrail on the def).
 * The decision is the bus's (subject = the config row); its id lands on the row in the deferred write.
 */
export async function servicingConfigWrite(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const loanId = need(i, "loan_id"); const db = dbOf(rt);
  const loan = (await db.query<Raw>(`SELECT l.id, pr.state, t.late_charge_pct_bps, t.late_charge_grace_days FROM loans l LEFT JOIN properties pr ON pr.id = l.property_id LEFT JOIN LATERAL (SELECT late_charge_pct_bps, late_charge_grace_days FROM loan_terms WHERE loan_id = l.id ORDER BY effective_from DESC, created_at DESC LIMIT 1) t ON true WHERE l.id = $1`, [loanId]))[0];
  if (!loan) throw new RangeError(`no loan ${loanId}`);
  const state = (str(i, "jurisdiction_state") || String(loan.state ?? "")).toUpperCase();
  if (!state) refuse("servicing_config.write", "CONFIG_REQUIRED", "35.5 rule 9", `loan ${loanId}: no property state and no jurisdiction_state given`);
  const j = await jurisdictionRulesFor(db, state);
  if (!j) refuse("servicing_config.write", "CONFIG_REQUIRED", "35.5 rule 9", `no jurisdiction_rules row for ${state}`);
  const asOf = D(str(i, "effective_from") || ctx.now.slice(0, 10));
  const explicitProfile = str(i, "servicer_profile_id") ? await servicerProfileById(db, str(i, "servicer_profile_id")) : null;
  if (str(i, "servicer_profile_id") && !explicitProfile) throw new RangeError(`no servicer profile ${str(i, "servicer_profile_id")}`);
  const party = explicitProfile?.servicing_party_id ?? (await platformServicingPartyId(db));
  const profile = explicitProfile ?? (party ? await activeServicerProfile(db, party, asOf) : null);
  if (!profile) refuse("servicing_config.write", "CONFIG_REQUIRED", "35.5 rule 9", `no active servicer profile on ${asOf}`);
  const bps = loan.late_charge_pct_bps === null || loan.late_charge_pct_bps === undefined ? 5000 : Number(loan.late_charge_pct_bps);
  const tzSource = str(i, "time_zone_source") as ServicingConfigRow["time_zone_source"] | "";
  const config = configFrom({ loan_id: loanId, state, late_charge_pct: (bps / 1000).toFixed(3), late_charge_grace_days: Number(loan.late_charge_grace_days ?? 15), effective_from: asOf, lockbox_id: str(i, "lockbox_id") || null, time_zone: str(i, "time_zone") || null, ...(tzSource ? { time_zone_source: tzSource } : {}), servicer_profile_id: explicitProfile?.id ?? null },
    j, profile, { actor: actorText(ctx.actor), reason: str(i, "reason") || null, at: "servicing_config.write" });
  ctx.events.append({ type: CONFIG_WRITTEN, loanId, actor: ctx.actor, payload: { loan_id: loanId, config_id: config.id, time_zone: config.time_zone, time_zone_source: config.time_zone_source, jurisdiction_state: config.jurisdiction_state, servicer_profile_id: config.servicer_profile_id, servicer_profile_version: profile.version, effective_from: config.effective_from, late_charge_terms: config.late_charge_terms, nsf_fee_allowed: config.nsf_fee_allowed, reason: str(i, "reason") || null } });
  deferOf(rt)(async (q) => {
    const decision = (await q.query<{ id: string }>(`SELECT id FROM agent_decisions WHERE subject_kind = 'loan_servicing_config' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1`, [config.id]))[0]?.id ?? null;
    await insertServicingConfig(q, { ...config, decision_id: decision });
  });
  return { config_id: config.id, loan_id: loanId, effective_from: config.effective_from, time_zone: config.time_zone, time_zone_source: config.time_zone_source, jurisdiction_state: config.jurisdiction_state, servicer_profile_id: config.servicer_profile_id, servicer_profile_version: profile.version, late_charge_terms: config.late_charge_terms, nsf_fee_allowed: config.nsf_fee_allowed };
}

/**
 * `servicer_profile.write{op: draft | activate, …}`: `draft` prepares a version (any profile field; defaults from the version in force);
 * `activate{version | profile_id, effective_from, reason, …fields}` is `compliance`'s act (the def's humanRoles and guardrails) — the prior
 * version is closed at the new effective date, `servicer_profile.activated{profile_id, version, effective_from, by, decision_id}` carries the
 * decision this handler records itself in the deferred write (the id rides on the event, so the def's own decision hook is off for this tool).
 */
export async function servicerProfileWrite(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const op = str(i, "op");
  if (op !== "draft" && op !== "activate") throw new RangeError("op must be draft or activate");
  const db = dbOf(rt);
  const party = str(i, "servicing_party_id") || (await platformServicingPartyId(db));
  if (!party) refuse("servicer_profile.write", "CONFIG_REQUIRED", "35.5 rule 9", "no servicing party on the platform (seed 0143)");
  const effectiveFrom = D(str(i, "effective_from") || ctx.now.slice(0, 10));
  // the version the new one is copied from: a named row, else the version in force today, else the latest version
  const named = str(i, "profile_id") ? await servicerProfileById(db, str(i, "profile_id")) : null;
  if (str(i, "profile_id") && !named) throw new RangeError(`no servicer profile ${str(i, "profile_id")}`);
  const base = named ?? (await activeServicerProfile(db, party, D(ctx.now.slice(0, 10)))) ?? (await db.query<Raw>(`SELECT ${PROFILE_COLS} FROM servicer_profiles WHERE servicing_party_id = $1 ORDER BY version DESC LIMIT 1`, [party])).map(profileOf)[0] ?? null;
  const latest = Number((await db.query<{ v: number | null }>(`SELECT max(version)::int AS v FROM servicer_profiles WHERE servicing_party_id = $1`, [party]))[0]?.v ?? 0);
  const version = str(i, "version") ? Number(str(i, "version")) : named?.status === "draft" ? named.version : latest + 1;
  if (!Number.isInteger(version) || version <= 0) throw new RangeError("version must be a positive integer");
  const fields: Record<string, string | null> = {};
  for (const k of PROFILE_FIELDS) if (i[k] !== undefined) fields[k] = i[k] === null ? null : String(i[k]);
  const pick = (k: (typeof PROFILE_FIELDS)[number], fallback: string): string => String(fields[k] ?? base?.[k] ?? fallback);
  const optional = (k: (typeof PROFILE_FIELDS)[number], fallback: string | null): string | null => (k in fields ? fields[k]! : base?.[k] ?? fallback);
  const languages = Array.isArray(i.languages) ? (i.languages as unknown[]).map(String) : base?.languages ?? [...FAKE_SERVICER_PROFILE_V1.languages];
  const draft: ProfileDraft = { servicing_party_id: party, version, effective_from: effectiveFrom, legal_name: pick("legal_name", FAKE_SERVICER_PROFILE_V1.legal_name), dba: optional("dba", null), nmls_id: optional("nmls_id", null), tin: optional("tin", null),
    toll_free_phone: pick("toll_free_phone", FAKE_SERVICER_PROFILE_V1.toll_free_phone), servicer_address: pick("servicer_address", FAKE_SERVICER_PROFILE_V1.servicer_address), exclusive_address: pick("exclusive_address", FAKE_SERVICER_PROFILE_V1.exclusive_address), remittance_address: pick("remittance_address", FAKE_SERVICER_PROFILE_V1.remittance_address),
    payment_requirements_version: optional("payment_requirements_version", null), portal_url: pick("portal_url", FAKE_SERVICER_PROFILE_V1.portal_url), counselor_url: pick("counselor_url", FAKE_SERVICER_PROFILE_V1.counselor_url), hud_phone: pick("hud_phone", FAKE_SERVICER_PROFILE_V1.hud_phone), hours: optional("hours", null), languages, status: op === "activate" ? "active" : "draft" };
  const profile_id = randomUUID(); const decision_id = randomUUID();
  const record = { action: `servicer_profile.${op}`, inputs: { servicing_party_id: party, version, effective_from: effectiveFrom, fields: Object.keys(fields), prior_version: base?.version ?? null, prior_profile_id: base?.id ?? null, reason: str(i, "reason") || null }, outputs: { profile_id }, rule_set_version: RULE_SET_CONFIG, model_version: MODEL_VERSION_DETERMINISTIC, prompt_version: PROMPT_VERSION_35_5, confidence: 1 };
  const decision: DecisionInput = { agent: ctx.actor.kind === "agent" ? ctx.actor.id : CASHIERING_AGENT.id, action: `servicer_profile.${op}`, rationale: toJson(record), ruleSetVersion: RULE_SET_CONFIG, subject: { kind: "servicer_profile", id: profile_id }, confidence: 1, modelVersion: MODEL_VERSION_DETERMINISTIC, promptVersion: PROMPT_VERSION_35_5,
    ...(ctx.actor.kind === "human" ? { approvedBy: ctx.actor.id, ...(ctx.actor.role ? { approvedRole: ctx.actor.role } : {}) } : {}) };
  const retireDraft = named?.status === "draft" ? named.id : null;   // a draft that is activated (or re-drafted) is retired: its row keeps every fact, only the status moves
  if (op === "draft") {
    ctx.events.append({ type: "servicer_profile.drafted", actor: ctx.actor, payload: { profile_id, servicing_party_id: party, version, effective_from: effectiveFrom, by: actorText(ctx.actor), decision_id, prior_version: base?.version ?? null } });
    deferOf(rt)(async (q) => { await new PgDecisionRepository(q).record(decision, q, decision_id); if (retireDraft) await q.query(`UPDATE servicer_profiles SET status = 'superseded' WHERE id = $1 AND status = 'draft'`, [retireDraft]); await insertServicerProfile(q, draft, profile_id); });
    return { profile_id, version, status: "draft", effective_from: effectiveFrom, decision_id };
  }
  if (!str(i, "reason")) throw new RangeError("activate needs a reason");
  const inForce = base && base.status !== "draft" ? base : null;
  if (inForce && version <= inForce.version) throw new RangeError(`version ${version} is not after the version in force (${inForce.version})`);
  if (inForce && effectiveFrom <= inForce.effective_from) throw new RangeError(`effective_from ${effectiveFrom} is not after the version in force (${inForce.effective_from})`);
  ctx.events.append({ type: PROFILE_ACTIVATED, actor: ctx.actor, payload: { profile_id, servicing_party_id: party, version, effective_from: effectiveFrom, by: actorText(ctx.actor), decision_id, reason: str(i, "reason"), prior_version: inForce?.version ?? null, exclusive_address: draft.exclusive_address } });
  deferOf(rt)(async (q) => {
    await new PgDecisionRepository(q).record(decision, q, decision_id);
    if (retireDraft) await q.query(`UPDATE servicer_profiles SET status = 'superseded' WHERE id = $1 AND status = 'draft'`, [retireDraft]);
    await activateServicerProfile(q, { ...draft, status: "active", approved_by_decision_id: decision_id }, profile_id);
  });
  return { profile_id, version, status: "active", effective_from: effectiveFrom, decision_id, exclusive_address: draft.exclusive_address };
}
