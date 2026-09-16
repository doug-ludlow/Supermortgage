/**
 * §35.5 rule 9 — per-loan time zone, jurisdiction and servicer identity replace the two constants.
 *
 *   STATE_TIME_ZONES                     the reviewed state → default IANA zone map (rule 9; split-zone states take the zone of
 *                                        most of their population and a county override or a manual `compliance` row fixes the rest).
 *   FAKE_SERVICER_CONTACT                the former `SERVICER_CONTACT` values (the authored samples' — [UNVERIFIED] until 31.x
 *                                        signs the go-live values): the FAKE build's `servicer_profiles` version 1.
 *   ensureServicerProfileV1(q, now)      seeds the FAKE servicing party and v1 (fixed ids; idempotent) — `status = active` from
 *                                        2020-01-01, so no rendered text changes until `compliance` activates v2.
 *   activeServicerProfile(q, asOf)       the version in force on a date; a date with no version is a typed refusal (CONFIG_REQUIRED —
 *                                        notices never render with a stale block).
 *   planServicingConfig / persist / append   the boarding transaction's config row (`time_zone` from the state map, `jurisdiction_state`,
 *                                        the active profile, 2.7's `lateChargeTerms(note, jurisdiction_rules.rules.late_charge)`,
 *                                        `nsf_fee_allowed` from `jurisdiction_rules.rules.nsf_fee`) and `loan.servicing_config.written`,
 *                                        which satisfies SM_LOAN_SERVICING_CONFIG_AT_BOARD_0 in the same commit.
 *   loanServicingConfig(q, loanId, asOf) the latest row effective on `asOf`; none → CONFIG_REQUIRED (never a default zone).
 *   loanLocalDate(timeZone, instant)     `wallClock(instant, time_zone).date` — every loan-local civil date.
 *   activateServicerProfile(q, …)        `compliance`'s activation of a new version: the prior active version's range closes at the
 *                                        new `effective_from`; `servicer_profile.activated{profile_id, version, effective_from, by}`.
 *
 * `jurisdiction_rules` is read here, never written.
 */
import type { Queryable } from "../../infra/db/client.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { encryptTin, tinCipherKey } from "../../infra/pii/tin.ts";
import { lateChargeTerms } from "../cashiering/latecharges.ts";

export const CONFIG_RULE_SET = "cashiering.schedule.v1";
export const CONFIG_EVENTS = { written: "loan.servicing_config.written", profileActivated: "servicer_profile.activated" } as const;

export class ConfigRequired extends Error {
  readonly code = "CONFIG_REQUIRED";
  constructor(message: string) { super(`CONFIG_REQUIRED: ${message}`); this.name = "ConfigRequired"; }
}

/** Rule 9's reviewed default zone per state (operational prerequisite: the split-zone states — AZ Navajo Nation, ID, OR, NE, KS, ND, SD, TX, TN, KY, FL, MI, IN — take their majority zone here; a county override or a manual `compliance` row is the exception). */
export const STATE_TIME_ZONES: Readonly<Record<string, string>> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago", CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York", DC: "America/New_York",
  FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu", ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago",
  ME: "America/New_York", MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago", MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago", NV: "America/Los_Angeles",
  NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York", OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York",
  RI: "America/New_York", SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver", VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles", WV: "America/New_York",
  WI: "America/Chicago", WY: "America/Denver", PR: "America/Puerto_Rico", VI: "America/Puerto_Rico", GU: "Pacific/Guam",
};
/** The state's reviewed default zone; a state outside the map is a typed refusal (rule 9: "the boarding never guesses"). */
export function stateTimeZone(state: string | null | undefined): string {
  const tz = state ? STATE_TIME_ZONES[state.toUpperCase()] : undefined;
  if (!tz) throw new ConfigRequired(`no reviewed time zone for state ${JSON.stringify(state ?? null)}; a manual compliance row is required (rule 9)`);
  return tz;
}

/** The former `SERVICER_CONTACT` (src/runtime/servicing.ts) — the FAKE build's servicer_profiles v1; the authored samples' values, [UNVERIFIED] for any real notice. */
export const FAKE_SERVICER_CONTACT = { servicer_name: "Supermortgage LLC", servicer_tin: "12-3456789", servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001", exclusive_address: "PO Box 2, Testville TX 75001", remittance_address: "Supermortgage, PO Box 7, Testville TX 75001", portal_url: "https://portal.example.com/statements", counselor_url: "consumerfinance.gov/find-a-housing-counselor", hud_phone: "(800) 569-4287" } as const;
/** Fixed ids for the FAKE servicing party and its v1 profile (idempotent seed across boarding transactions). */
export const FAKE_SERVICING_PARTY_ID = "00000000-0000-4000-8000-000000350501";
export const FAKE_SERVICER_PROFILE_V1_ID = "00000000-0000-4000-8000-000000350511";
export const FAKE_SERVICER_PROFILE_V1_EFFECTIVE_FROM = D("2020-01-01");

export interface ServicerProfile {
  readonly id: string; readonly servicing_party_id: string; readonly version: number; readonly effective_from: PlainDate; readonly effective_to: PlainDate | null;
  readonly legal_name: string; readonly dba: string | null; readonly nmls_id: string | null; readonly tin_last4: string | null; readonly tin_encrypted: Buffer | null;
  readonly toll_free_phone: string; readonly servicer_address: string; readonly exclusive_address: string; readonly remittance_address: string; readonly payment_requirements_version: string | null;
  readonly portal_url: string | null; readonly counselor_url: string | null; readonly hud_phone: string | null; readonly hours: string | null; readonly languages: string[]; readonly status: "draft" | "active" | "superseded"; readonly approved_by_decision_id: string | null;
}
type Raw = Record<string, unknown>;
const PROFILE_COLS = `id::text AS id, servicing_party_id::text AS servicing_party_id, version, effective_from::text AS effective_from, effective_to::text AS effective_to, legal_name, dba, nmls_id, tin_last4, tin_encrypted, toll_free_phone, servicer_address, exclusive_address, remittance_address, payment_requirements_version, portal_url, counselor_url, hud_phone, hours, languages, status, approved_by_decision_id::text AS approved_by_decision_id`;
const profileOf = (r: Raw): ServicerProfile => ({ id: String(r.id), servicing_party_id: String(r.servicing_party_id), version: Number(r.version), effective_from: D(String(r.effective_from).slice(0, 10)), effective_to: r.effective_to ? D(String(r.effective_to).slice(0, 10)) : null,
  legal_name: String(r.legal_name), dba: (r.dba as string | null) ?? null, nmls_id: (r.nmls_id as string | null) ?? null, tin_last4: (r.tin_last4 as string | null) ?? null, tin_encrypted: r.tin_encrypted ? Buffer.from(r.tin_encrypted as Uint8Array) : null,
  toll_free_phone: String(r.toll_free_phone), servicer_address: String(r.servicer_address), exclusive_address: String(r.exclusive_address), remittance_address: String(r.remittance_address), payment_requirements_version: (r.payment_requirements_version as string | null) ?? null,
  portal_url: (r.portal_url as string | null) ?? null, counselor_url: (r.counselor_url as string | null) ?? null, hud_phone: (r.hud_phone as string | null) ?? null, hours: (r.hours as string | null) ?? null, languages: Array.isArray(r.languages) ? (r.languages as string[]) : [], status: String(r.status) as ServicerProfile["status"], approved_by_decision_id: (r.approved_by_decision_id as string | null) ?? null });

/** The servicer block every notice renders (the 7.1 statement's eight fields plus the 1098's name and TIN). */
export function servicerBlock(p: ServicerProfile): { servicer_name: string; servicer_tin_last4: string | null; servicer_phone: string; servicer_address: string; exclusive_address: string; remittance_address: string; portal_url: string; counselor_url: string; hud_phone: string; servicer_profile_id: string; servicer_profile_version: number } {
  return { servicer_name: p.legal_name, servicer_tin_last4: p.tin_last4, servicer_phone: p.toll_free_phone, servicer_address: p.servicer_address, exclusive_address: p.exclusive_address, remittance_address: p.remittance_address, portal_url: p.portal_url ?? "", counselor_url: p.counselor_url ?? "", hud_phone: p.hud_phone ?? "", servicer_profile_id: p.id, servicer_profile_version: p.version };
}

/** The FAKE servicing party and v1 (fixed ids, `ON CONFLICT DO NOTHING`): seeded on first need by any boarding transaction or notice render. */
export async function ensureServicerProfileV1(q: Queryable): Promise<ServicerProfile> {
  const found = await q.query<Raw>(`SELECT ${PROFILE_COLS} FROM servicer_profiles WHERE id = $1`, [FAKE_SERVICER_PROFILE_V1_ID]);
  if (found[0]) return profileOf(found[0]);
  await q.query(`INSERT INTO parties (id, party_type, legal_name, contact) VALUES ($1, 'servicer', $2, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`, [FAKE_SERVICING_PARTY_ID, FAKE_SERVICER_CONTACT.servicer_name]);
  const c = FAKE_SERVICER_CONTACT;
  await q.query(`INSERT INTO servicer_profiles (id, servicing_party_id, version, effective_from, legal_name, tin_encrypted, tin_last4, toll_free_phone, servicer_address, exclusive_address, remittance_address, portal_url, counselor_url, hud_phone, status)
    VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'active') ON CONFLICT (id) DO NOTHING`,
    [FAKE_SERVICER_PROFILE_V1_ID, FAKE_SERVICING_PARTY_ID, FAKE_SERVICER_PROFILE_V1_EFFECTIVE_FROM, c.servicer_name, encryptTin(c.servicer_tin, tinCipherKey()), c.servicer_tin.replace(/\D/g, "").slice(-4), c.servicer_phone, c.servicer_address, c.exclusive_address, c.remittance_address, c.portal_url, c.counselor_url, c.hud_phone]);
  return profileOf((await q.query<Raw>(`SELECT ${PROFILE_COLS} FROM servicer_profiles WHERE id = $1`, [FAKE_SERVICER_PROFILE_V1_ID]))[0]!);
}

/** The version in force on `asOf` for the servicing party (the FAKE party by default); seeds v1 when the table is empty; none in force → CONFIG_REQUIRED. */
export async function activeServicerProfile(q: Queryable, asOf: PlainDate, partyId: string = FAKE_SERVICING_PARTY_ID): Promise<ServicerProfile> {
  const any = await q.query<{ c: string }>(`SELECT count(*)::text AS c FROM servicer_profiles WHERE servicing_party_id = $1`, [partyId]);
  if (Number(any[0]!.c) === 0 && partyId === FAKE_SERVICING_PARTY_ID) await ensureServicerProfileV1(q);
  const rows = await q.query<Raw>(`SELECT ${PROFILE_COLS} FROM servicer_profiles WHERE servicing_party_id = $1 AND status IN ('active', 'superseded') AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to > $2::date) ORDER BY version DESC LIMIT 1`, [partyId, asOf]);
  if (!rows[0]) throw new ConfigRequired(`no servicer_profiles version is in force on ${asOf} for party ${partyId}; compliance must activate one before a notice renders`);
  return profileOf(rows[0]);
}
export async function servicerProfileById(q: Queryable, id: string): Promise<ServicerProfile | null> {
  const rows = await q.query<Raw>(`SELECT ${PROFILE_COLS} FROM servicer_profiles WHERE id = $1`, [id]);
  return rows[0] ? profileOf(rows[0]) : null;
}
export async function servicerProfileVersions(q: Queryable, partyId: string = FAKE_SERVICING_PARTY_ID): Promise<ServicerProfile[]> {
  return (await q.query<Raw>(`SELECT ${PROFILE_COLS} FROM servicer_profiles WHERE servicing_party_id = $1 ORDER BY version`, [partyId])).map(profileOf);
}

export interface JurisdictionCashRules { readonly late_charge: { max_pct: string; min_grace_days: number } | null; readonly nsf_fee: { allowed: boolean; cap_cents: Cents | null } | null; }
/** `jurisdiction_rules.rules.late_charge` / `.nsf_fee` for a state (read, never written here); an absent row is `null` rules — the note's terms and the 2.7 policy fee apply. */
export async function jurisdictionCashRules(q: Queryable, state: string): Promise<JurisdictionCashRules> {
  const rows = await q.query<{ rules: Raw | null }>(`SELECT rules FROM jurisdiction_rules WHERE state = $1`, [state.toUpperCase()]);
  const rules = rows[0]?.rules ?? null;
  const lc = rules && rules.late_charge && typeof rules.late_charge === "object" ? (rules.late_charge as Raw) : null;
  const nsf = rules && rules.nsf_fee && typeof rules.nsf_fee === "object" ? (rules.nsf_fee as Raw) : null;
  return {
    late_charge: lc && lc.max_pct !== undefined ? { max_pct: String(lc.max_pct), min_grace_days: Number(lc.min_grace_days ?? 15) } : null,
    nsf_fee: nsf ? { allowed: nsf.allowed !== false, cap_cents: nsf.cap_cents === null || nsf.cap_cents === undefined ? null : BigInt(String(nsf.cap_cents)) } : null,
  };
}

export interface ServicingConfigPlan {
  readonly id: string; readonly loan_id: string; readonly effective_from: PlainDate; readonly time_zone: string; readonly time_zone_source: "state_default" | "county_override" | "borrower_stated" | "manual";
  readonly jurisdiction_state: string; readonly servicer_profile_id: string; readonly lockbox_id: string | null; readonly channels_enabled: readonly string[];
  readonly late_charge_terms: ReturnType<typeof lateChargeTerms>; readonly nsf_fee_allowed: boolean; readonly nsf_cap_cents: Cents | null; readonly written_by: Record<string, unknown>;
}
export interface ServicingConfigInput {
  readonly loan_id: string; readonly effective_from: PlainDate; readonly state: string | null | undefined;
  readonly note: { pct: string; grace_days: number };
  readonly rules: JurisdictionCashRules; readonly servicer_profile_id: string;
  readonly time_zone?: string | null; readonly time_zone_source?: ServicingConfigPlan["time_zone_source"];
  readonly lockbox_id?: string | null; readonly channels_enabled?: readonly string[]; readonly written_by: Record<string, unknown>;
}
/** Rule 9 — the configuration row's contents (pure). */
export function planServicingConfig(i: ServicingConfigInput): ServicingConfigPlan {
  if (!i.state || !/^[A-Za-z]{2}$/.test(i.state)) throw new ConfigRequired(`loan ${i.loan_id}: properties.state ${JSON.stringify(i.state ?? null)} is not a state; the jurisdiction and time zone cannot be configured`);
  const state = i.state.toUpperCase();
  const tz = i.time_zone ?? stateTimeZone(state);
  const lc = lateChargeTerms(i.note, i.rules.late_charge ? { ...i.rules.late_charge, state } : null);
  return { id: crypto.randomUUID(), loan_id: i.loan_id, effective_from: i.effective_from, time_zone: tz, time_zone_source: i.time_zone_source ?? (i.time_zone ? "manual" : "state_default"), jurisdiction_state: state, servicer_profile_id: i.servicer_profile_id,
    lockbox_id: i.lockbox_id ?? "LBX-1", channels_enabled: i.channels_enabled ?? ["lockbox", "ach_debit_origin", "portal_onetime"], late_charge_terms: lc, nsf_fee_allowed: i.rules.nsf_fee ? i.rules.nsf_fee.allowed : false, nsf_cap_cents: i.rules.nsf_fee?.cap_cents ?? null, written_by: i.written_by };   // NSF_ONLY_WHERE_ALLOWED: no jurisdiction row on file → no authority → no fee (never invented)
}
export async function persistServicingConfig(q: Queryable, p: ServicingConfigPlan, opts: { decision_id?: string | null } = {}): Promise<void> {
  await q.query(`INSERT INTO loan_servicing_configs (id, loan_id, effective_from, time_zone, time_zone_source, jurisdiction_state, servicer_profile_id, lockbox_id, channels_enabled, late_charge_terms, nsf_fee_allowed, written_by, decision_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::jsonb, $11, $12::jsonb, $13)`,
    [p.id, p.loan_id, p.effective_from, p.time_zone, p.time_zone_source, p.jurisdiction_state, p.servicer_profile_id, p.lockbox_id, [...p.channels_enabled], JSON.stringify({ ...p.late_charge_terms, nsf_cap_cents: p.nsf_cap_cents === null ? null : p.nsf_cap_cents.toString() }), p.nsf_fee_allowed, JSON.stringify(p.written_by), opts.decision_id ?? null]);
}
export function appendConfigWritten(events: EventStore, p: ServicingConfigPlan, actor: Actor, opts: { causationId?: string } = {}): DomainEvent {
  return events.append({ type: CONFIG_EVENTS.written, loanId: p.loan_id, aggregate: { kind: "loan_servicing_config", id: p.id }, actor, ...(opts.causationId ? { causationId: opts.causationId } : {}),
    payload: { loan_id: p.loan_id, config_id: p.id, time_zone: p.time_zone, time_zone_source: p.time_zone_source, jurisdiction_state: p.jurisdiction_state, servicer_profile_id: p.servicer_profile_id, effective_from: p.effective_from, late_charge_terms: { pct: p.late_charge_terms.pct, grace_days: p.late_charge_terms.grace_days, conflict: p.late_charge_terms.conflict }, nsf_fee_allowed: p.nsf_fee_allowed, rule_set_version: CONFIG_RULE_SET } });
}

export interface LoanServicingConfig {
  readonly id: string; readonly loan_id: string; readonly effective_from: PlainDate; readonly time_zone: string; readonly time_zone_source: string; readonly jurisdiction_state: string; readonly servicer_profile_id: string; readonly lockbox_id: string | null; readonly channels_enabled: string[];
  readonly late_charge_terms: { pct: string; grace_days: number; conflict: unknown | null; nsf_cap_cents: Cents | null }; readonly nsf_fee_allowed: boolean;
}
const CONFIG_COLS = `id::text AS id, loan_id::text AS loan_id, effective_from::text AS effective_from, time_zone, time_zone_source, jurisdiction_state, servicer_profile_id::text AS servicer_profile_id, lockbox_id, channels_enabled, late_charge_terms, nsf_fee_allowed`;
const configOf = (r: Raw): LoanServicingConfig => { const lc = (r.late_charge_terms ?? {}) as Raw; return { id: String(r.id), loan_id: String(r.loan_id), effective_from: D(String(r.effective_from).slice(0, 10)), time_zone: String(r.time_zone), time_zone_source: String(r.time_zone_source), jurisdiction_state: String(r.jurisdiction_state), servicer_profile_id: String(r.servicer_profile_id), lockbox_id: (r.lockbox_id as string | null) ?? null, channels_enabled: Array.isArray(r.channels_enabled) ? (r.channels_enabled as string[]) : [],
  late_charge_terms: { pct: String(lc.pct ?? "5"), grace_days: Number(lc.grace_days ?? 15), conflict: lc.conflict ?? null, nsf_cap_cents: lc.nsf_cap_cents === null || lc.nsf_cap_cents === undefined ? null : BigInt(String(lc.nsf_cap_cents)) }, nsf_fee_allowed: r.nsf_fee_allowed !== false }; };
/** Rule 9 — the loan's configuration on `asOf` (the latest row with `effective_from ≤ asOf`); none → CONFIG_REQUIRED, never a default zone. */
export async function loanServicingConfig(q: Queryable, loanId: string, asOf: PlainDate): Promise<LoanServicingConfig> {
  const rows = await q.query<Raw>(`SELECT ${CONFIG_COLS} FROM loan_servicing_configs WHERE loan_id = $1 AND effective_from <= $2::date ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [loanId, asOf]);
  if (!rows[0]) throw new ConfigRequired(`loan ${loanId} has no loan_servicing_configs row effective on ${asOf}; no loan-local date, jurisdiction or servicer block without one (rule 9)`);
  return configOf(rows[0]);
}
export async function loanServicingConfigOrNull(q: Queryable, loanId: string, asOf: PlainDate): Promise<LoanServicingConfig | null> {
  try { return await loanServicingConfig(q, loanId, asOf); } catch (e) { if (e instanceof ConfigRequired) return null; throw e; }
}
/** Every loan-local civil date is `wallClock(instant, config.time_zone).date`. */
export const loanLocalDate = (timeZone: string, instantIso: string): PlainDate => wallClock(Date.parse(instantIso), timeZone).date;

export interface ActivateProfileInput {
  readonly party_id?: string; readonly effective_from: PlainDate; readonly by: Actor; readonly decision_id?: string | null; readonly today: PlainDate;
  readonly fields: Partial<Pick<ServicerProfile, "legal_name" | "dba" | "nmls_id" | "toll_free_phone" | "servicer_address" | "exclusive_address" | "remittance_address" | "payment_requirements_version" | "portal_url" | "counselor_url" | "hud_phone" | "hours" | "languages">> & { tin?: string | null };
}
/** State machine: the new version `active` from `effective_from`; the version active there closes at that date (and is `superseded` once the date has come). */
export async function activateServicerProfile(q: Queryable, events: EventStore, i: ActivateProfileInput): Promise<ServicerProfile> {
  const partyId = i.party_id ?? FAKE_SERVICING_PARTY_ID;
  const versions = await servicerProfileVersions(q, partyId);
  if (!versions.length && partyId === FAKE_SERVICING_PARTY_ID) { await ensureServicerProfileV1(q); versions.push(...(await servicerProfileVersions(q, partyId))); }
  const base = versions.filter((v) => v.status !== "draft").sort((a, b) => b.version - a.version)[0];
  if (!base) throw new ConfigRequired(`party ${partyId} has no servicer profile version to build on`);
  if (i.effective_from < i.today) throw new RangeError(`a servicer profile version activates today or later (effective_from ${i.effective_from} < ${i.today}); notices are stored bytes and a profile change re-renders nothing retroactively`);
  const version = Math.max(...versions.map((v) => v.version)) + 1;
  const f = i.fields; const tin = f.tin === undefined ? null : f.tin;
  const id = crypto.randomUUID();
  // close every active version whose range reaches the new effective date
  for (const v of versions) if (v.status === "active" && (v.effective_to === null || v.effective_to > i.effective_from)) {
    if (v.effective_from >= i.effective_from) throw new RangeError(`version ${v.version} already begins on/after ${i.effective_from}; activate a later date`);
    await q.query(`UPDATE servicer_profiles SET effective_to = $2::date, status = CASE WHEN $2::date <= $3::date THEN 'superseded' ELSE status END WHERE id = $1`, [v.id, i.effective_from, i.today]);
  }
  await q.query(`INSERT INTO servicer_profiles (id, servicing_party_id, version, effective_from, legal_name, dba, nmls_id, tin_encrypted, tin_last4, toll_free_phone, servicer_address, exclusive_address, remittance_address, payment_requirements_version, portal_url, counselor_url, hud_phone, hours, languages, status, approved_by_decision_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::text[], 'active', $20)`,
    [id, partyId, version, i.effective_from, f.legal_name ?? base.legal_name, f.dba ?? base.dba, f.nmls_id ?? base.nmls_id, tin ? encryptTin(tin, tinCipherKey()) : base.tin_encrypted, tin ? tin.replace(/\D/g, "").slice(-4) : base.tin_last4,
      f.toll_free_phone ?? base.toll_free_phone, f.servicer_address ?? base.servicer_address, f.exclusive_address ?? base.exclusive_address, f.remittance_address ?? base.remittance_address, f.payment_requirements_version ?? base.payment_requirements_version, f.portal_url ?? base.portal_url, f.counselor_url ?? base.counselor_url, f.hud_phone ?? base.hud_phone, f.hours ?? base.hours, f.languages ?? base.languages, i.decision_id ?? null]);
  events.append({ type: CONFIG_EVENTS.profileActivated, aggregate: { kind: "servicer_profile", id }, actor: i.by, payload: { profile_id: id, servicing_party_id: partyId, version, effective_from: i.effective_from, by: `${i.by.kind}:${i.by.id}${i.by.role ? `:${i.by.role}` : ""}`, decision_id: i.decision_id ?? null, supersedes_version: base.version, changed: Object.keys(f).filter((k) => k !== "tin"), tin_changed: !!tin } });
  return (await servicerProfileById(q, id))!;
}
