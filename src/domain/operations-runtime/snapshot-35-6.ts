/**
 * §35.6 rule 6 — the hand-off snapshot built from the record, field by field, with its sources stored.
 *
 * `buildFundingSnapshot` produces 30.2's `OriginationSnapshot` (src/domain/orig-boarding/ops-30-2.ts) from the owners' events
 * and rows: 26.1's eNote/note and note terms, 26.2's consummation, 25.2's consummated CD version, 26.3's `loan.funded`, 25.1's
 * gate run, 30.3's frozen analysis, 23.4's HPML/QM determinations, DU's LTV, 24.6's certificate, 24.5's hazard/flood, 26.2's
 * registration and custody, 27.1's advance, 21.1's borrowers with the restricted demographics row, the consents and their
 * disclosure versions, the subject property with 24.1's value, 35.2's documents, 26.4's trailing documents, 24.4's parcel,
 * 30.3's statement, the autopay consent. Every path the record cannot supply goes to `gaps`; under ENVIRONMENT=production a gap
 * refuses the hand-off `FIXTURE_REFUSED` (no loans row; an ops_analyst and a compliance escalation name the paths); in nonprod
 * the gap is filled from `demoSnapshot` with `fixture_used = true` and the paths listed (the daily receipt counts it).
 *
 * `fundFromSnapshot` is 30.2's hand-off from a stored `funding_snapshots` row (src/runtime/origination.ts fundApplication —
 * one `loans` row, idempotent by application id); an officer's `snapshot` overrides replace whole top-level fields (30.2's
 * correction rule: a snapshot is replaced, never edited). Nothing here appends an owner's event.
 */
import { createHash } from "node:crypto";
import type { Runtime } from "../../runtime/app.ts";
import type { Actor, DomainEvent } from "../../kernel/events/index.ts";
import type { OriginationSnapshot, OrigBorrower, OrigConsent, OrigDocument } from "../orig-boarding/ops-30-2.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { demoSnapshot, fundApplication, fundedFromLog, type FundApplicationResult } from "../../runtime/origination.ts";
import { loadRecord, src, type OrchRecord, type Source, RecordGap } from "./facts-35-6.ts";
import { closingFacts, partyFacts, loanTerms, escrowFacts, cdRow, productFacts, ltvPct, type ClosingFacts } from "./facts-35-6-b.ts";
import { environmentOf } from "./fakes-35-6.ts";
import { orchestrationByApplication, EV, ORCH_ACTOR } from "./orchestration-35-6.ts";

type Row = Record<string, unknown>;
const S = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const cents = (v: unknown): bigint => (typeof v === "bigint" ? v : v === null || v === undefined || v === "" ? 0n : BigInt(String(v)));
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export class SnapshotRefused extends Error {
  readonly code: string; readonly gaps: readonly string[];
  constructor(code: string, message: string, gaps: readonly string[] = []) { super(message); this.name = "SnapshotRefused"; this.code = code; this.gaps = gaps; }
}

export interface SnapshotEscalation { readonly kind: "ops_analyst" | "compliance"; readonly ownerRole: string; readonly severity: string; readonly payload: Row }
export interface SnapshotBuild {
  readonly snapshot_id: string | null; readonly orchestration_id: string | null; readonly snapshot_hash: string; readonly gaps: readonly string[]; readonly fixture_used: boolean; readonly environment: string;
  readonly refused_code: string | null; readonly sources: Record<string, Source>; readonly snapshot: OriginationSnapshot; readonly escalations: readonly SnapshotEscalation[]; readonly event_id: string | null;
}

/** The builder's ledger of where each path came from, and which paths the record could not supply. */
class Provenance {
  readonly sources: Record<string, Source> = {}; readonly gaps: string[] = [];
  event(path: string, e: DomainEvent, process: string): void { this.sources[path] = src("event", `${e.type}:${e.id}`, process); }
  entity(path: string, kind: string, id: string, version: number | string, process: string): void { this.sources[path] = src("entity", `${kind}:${id}:${version}`, process); }
  table(path: string, ref: string, process: string): void { this.sources[path] = src("table", ref, process); }
  derived(path: string, ref: string, process: string): void { this.sources[path] = src("derived", ref, process); }
  gap(path: string, why: string): void { if (!this.gaps.includes(path)) this.gaps.push(path); this.sources[path] = src("derived", `GAP: ${why}`, "35.6"); }
}

/** Canonical JSON: keys sorted, bigints as decimal strings — the hash and the stored row agree byte for byte. */
export function canonical(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as Row).sort().map((k) => [k, canonical((v as Row)[k])]));
  return v;
}
export const snapshotHash = (s: OriginationSnapshot): string => createHash("sha256").update(JSON.stringify(canonical(s))).digest("hex");
/** The stored form: the borrowers' dates of birth absent (re-read from application_borrowers at the hand-off; the TIN is already the last four). */
export const redactForStorage = (s: OriginationSnapshot): OriginationSnapshot => ({ ...s, borrowers: s.borrowers.map((b) => ({ ...b, dob: null })) });
/** The hand-off form: the dates of birth back from 21.1's rows (by the borrower's application_borrowers id). */
async function rehydrate(rt: Runtime, applicationId: string, s: OriginationSnapshot): Promise<OriginationSnapshot> {
  const rows = await rt.db.query<{ id: string; date_of_birth: string | null }>(`SELECT id::text AS id, date_of_birth::text AS date_of_birth FROM application_borrowers WHERE application_id = $1`, [applicationId]);
  return { ...s, borrowers: s.borrowers.map((b) => { const r = rows.find((x) => x.id === b.party_id); return r?.date_of_birth ? { ...b, dob: D(r.date_of_birth) } : b; }) };
}
/** The stored row back into 30.2's types: every `*_cents` a bigint again (nested), dates as PlainDate strings. */
export function reviveSnapshot(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reviveSnapshot);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k, /_cents$/.test(k) && (typeof x === "string" || typeof x === "number") ? BigInt(x) : reviveSnapshot(x)]));
  return v;
}

// ───────────────────────────── the record → the snapshot ─────────────────────────────
async function borrowersFromRecord(rt: Runtime, rec: OrchRecord, prov: Provenance): Promise<OrigBorrower[]> {
  // PII discipline (0190 header; 32.18 rule 7): the snapshot carries the TIN's last four only (30.2 boards `tin_last4`; 23.6 alone reads the cipher) and the date of birth is re-read from application_borrowers at the hand-off — neither leaves this builder in full
  const rows = await rt.db.query<{ id: string; borrower_role: string; legal_name: string; tin_last4: string | null; date_of_birth: string | null; language_preference: string | null; contact: Row | null; borrower_ordinal: number | null }>(
    `SELECT id::text AS id, borrower_role, legal_name, tin_last4, date_of_birth::text AS date_of_birth, language_preference, contact, borrower_ordinal FROM application_borrowers WHERE application_id = $1 ORDER BY borrower_ordinal NULLS LAST, created_at`, [rec.app.id]);
  if (!rows.length) { prov.gap("borrowers", "no application_borrowers rows (21.1)"); return []; }
  const demo = await rt.db.query<{ application_borrower_id: string; race: unknown; ethnicity: unknown; sex: string | null; age: number | null; declined_race: boolean; declined_ethnicity: boolean; declined_sex: boolean; visual_observation_used: boolean; collection_channel: string | null }>(
    `SELECT application_borrower_id::text AS application_borrower_id, race, ethnicity, sex, age, declined_race, declined_ethnicity, declined_sex, visual_observation_used, collection_channel FROM restricted_fl.applicant_demographics WHERE application_borrower_id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
  const out: OrigBorrower[] = [];
  rows.forEach((r, k) => {
    const d = demo.find((x) => x.application_borrower_id === r.id) ?? null;
    const contact = r.contact ?? {};
    const address = S(contact["mailing_address"]) ?? (contact["address"] && typeof contact["address"] === "object" ? Object.values(contact["address"] as Row).filter(Boolean).join(", ") : null);
    const tin = r.tin_last4 && /^\d{4}$/.test(r.tin_last4) ? r.tin_last4 : null;
    if (!tin) prov.gap(`borrowers[${k}].tin`, `application_borrowers ${r.id} carries no TIN (21.1 / 32.2 confirmField{ssn})`);
    if (!r.date_of_birth) prov.gap(`borrowers[${k}].dob`, `application_borrowers ${r.id} carries no date of birth (21.1)`);
    const list = (v: unknown): readonly string[] | null => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : null);
    // 21.1 applicant_demographics (restricted): self-reported when the borrower answered; "information not provided" when declined — never inferred (30.2 INFERRED_DEMOGRAPHICS)
    // a visually observed row (lawful only in person, 0057) is neither self-reported nor "not provided" as 30.2 types them — a gap, never relabelled
    if (d?.visual_observation_used) prov.gap(`borrowers[${k}].demographics`, `applicant_demographics for application_borrower ${r.id} was visually observed (collection_channel ${d.collection_channel}); 30.2 boards self-reported or not-provided answers only`);
    const demographics: OrigBorrower["demographics"] = d && !d.visual_observation_used
      ? { race: d.declined_race || !list(d.race)?.length ? "not_provided" : list(d.race)!, ethnicity: d.declined_ethnicity || !list(d.ethnicity)?.length ? "not_provided" : list(d.ethnicity)!, sex: d.declined_sex || !d.sex ? "not_provided" : d.sex, age: d.age, preferred_language: r.language_preference, collected_via: d.declined_race && d.declined_ethnicity && d.declined_sex ? "not_provided" : "self_reported" }
      : { race: "not_provided", ethnicity: "not_provided", sex: "not_provided", age: null, preferred_language: r.language_preference, collected_via: "not_provided" };
    if (d && !d.visual_observation_used) prov.table(`borrowers[${k}].demographics`, `restricted_fl.applicant_demographics:${r.id}`, "21.1"); else if (!d) prov.gap(`borrowers[${k}].demographics`, `no restricted_fl.applicant_demographics row for application_borrower ${r.id} (21.1)`);
    prov.table(`borrowers[${k}]`, `application_borrowers:${r.id}`, "21.1");
    out.push({ party_id: r.id, legal_name: r.legal_name, tin, dob: r.date_of_birth ? D(r.date_of_birth) : null, phone: S(contact["phone"]) ?? S(contact["mobile"]), email: S(contact["email"]), mailing_address: address, language_preference: r.language_preference, acp_enrolled: contact["acp_enrolled"] === true, role: r.borrower_role === "coborrower" || k > 0 ? "coborrower" : "borrower", demographics });
  });
  prov.table("borrowers", `application_borrowers:${rows.map((r) => r.id).join(",")}`, "21.1");
  return out;
}

async function consentsFromRecord(rt: Runtime, rec: OrchRecord, partnerName: string, prov: Provenance): Promise<{ consents: OrigConsent[]; versions: OriginationSnapshot["disclosure_versions"]; ach: boolean }> {
  const rows = await rt.db.query<{ id: string; kind: string; party_id: string | null; borrower_id: string | null; captured_at: string; captured_via: string | null; evidence_document_id: string | null; disclosure_version_id: string | null; version: string | null; scope: string[] | null; granted: boolean; status: string | null; hw_sw_version: string | null; revoked_at: string | null }>(
    `SELECT c.id::text AS id, c.kind::text AS kind, c.party_id::text AS party_id, c.borrower_id::text AS borrower_id, c.captured_at::text AS captured_at, c.captured_via, c.evidence_document_id::text AS evidence_document_id, c.disclosure_version_id::text AS disclosure_version_id, v.version, c.scope, c.granted, c.status, c.hw_sw_version, c.revoked_at::text AS revoked_at
       FROM consents c LEFT JOIN consent_disclosure_versions v ON v.id = c.disclosure_version_id WHERE c.application_id = $1 ORDER BY c.captured_at, c.id`, [rec.app.id]);
  const borrowers = rec.app.borrowers;
  const partyOf = (r: { party_id: string | null; borrower_id: string | null }): string => r.party_id ?? borrowers.find((b) => b.borrower_id === r.borrower_id)?.id ?? r.borrower_id ?? "";
  const kindOf = (k: string): OrigConsent["kind"] | null => (k === "esign" || k === "esign_disclosures" ? "esign" : k === "tcpa_voice" || k === "ai_voice" ? "tcpa_voice" : k === "tcpa_sms" ? "tcpa_sms" : k === "autopay" ? "ach" : null);
  const via = (v: string | null): OrigConsent["captured_via"] => (v === "ai_chat_link" || v === "ai_voice_link" || v === "voice" || v === "paper" ? v : "portal");
  const consents: OrigConsent[] = []; const versions: Record<string, { categories: string[]; providers: string[]; delivery_form: "portal_pdf" | "other" }> = {};
  for (const r of rows) {
    const kind = kindOf(r.kind); if (!kind || r.revoked_at || r.granted === false || r.status === "withdrawn" || r.status === "declined") continue;
    const version = r.version ?? (r.hw_sw_version ? `hw_sw:${r.hw_sw_version}` : undefined);
    consents.push({ id: r.id, party_id: partyOf(r), kind, ...(version ? { disclosure_version: version } : {}), ...(kind === "esign" ? { servicing_group_elected: (r.scope ?? []).some((c) => /servic|statement|escrow|notice/i.test(c)), demonstration_passed: true, demonstration_channel: "portal" as const } : {}), captured_via: via(r.captured_via), captured_at: r.captured_at, evidence_document_id: r.evidence_document_id });
    if (version) { const v = versions[version] ?? (versions[version] = { categories: [], providers: [partnerName, "its servicer Supermortgage"], delivery_form: "portal_pdf" }); for (const c of r.scope ?? []) if (!v.categories.includes(c)) v.categories.push(c); }
  }
  if (rows.length) prov.table("consents", `consents:${rows.map((r) => r.id).join(",")}`, "21.1"); else prov.gap("consents", "no consents rows for the application (21.1)");
  prov.table("disclosure_versions", `consent_disclosure_versions:${[...new Set(rows.map((r) => r.disclosure_version_id).filter(Boolean))].join(",") || "(none)"}`, "21.1");
  const ach = rows.some((r) => r.kind === "autopay" && r.granted !== false && !r.revoked_at);
  prov.table("ach_autopay_elected", ach ? `consents:${rows.find((r) => r.kind === "autopay")!.id}` : "consents: no autopay consent", "32.8");
  return { consents, versions, ach };
}

async function documentsFromRecord(rt: Runtime, rec: OrchRecord, closing: ClosingFacts | null, custodyKind: "paper" | "enote", prov: Provenance): Promise<OrigDocument[]> {
  const rows = await rt.db.query<{ id: string; kind: string; sha256: string; doc_class: string | null }>(`SELECT id::text AS id, kind, sha256, doc_class FROM documents WHERE application_id = $1 ORDER BY created_at, id`, [rec.app.id]);
  const out: OrigDocument[] = [];
  const kindOf = (k: string, cls: string | null): string => (k === "enote" || k === "note" ? "note" : k === "closing_disclosure" || k === "closing_disclosure_final" ? "closing_disclosure_final" : k === "loan_estimate" || k === "le" ? "loan_estimate" : k === "deed_of_trust" || k === "mortgage" ? "security_instrument" : cls === "security_instrument" ? "security_instrument" : k);
  for (const r of rows) { const kind = kindOf(r.kind, r.doc_class); out.push({ id: r.id, kind, sha256: r.sha256, custody: kind === "note" ? (custodyKind === "enote" ? "evault" : "custodian") : "platform", ...(kind === "recorded_security_instrument" ? { recorded: true } : {}) }); }
  // 26.1's rendered set: the note (eNote or paper), the security instrument, the final 1003 — `closing_documents` rows carry the render hash (documents rows of the same id when 26.1 stored them)
  for (const d of rec.entities("closing_documents")) {
    if (out.some((o) => o.id === d.id)) continue;
    const k = String(d.data["kind"]); const kind = k === "enote" || k === "note" ? "note" : k === "security_instrument" || k === "deed_of_trust" || k === "mortgage" ? "security_instrument" : k;
    const sha = S(d.data["render_hash"]) ?? S(d.data["sha256"]) ?? S(d.data["data_hash"]); if (!sha) continue;
    out.push({ id: d.id, kind, sha256: sha, custody: kind === "note" ? (custodyKind === "enote" ? "evault" : "custodian") : "platform" });
  }
  // the final CD as 25.2's disclosures row names it (its 35.2 document, when the render stored one)
  const cd = cdRow(rec); const cdDoc = cd ? (S(cd.data["document_id"]) ?? S(cd.data["pdf_document_id"])) : null;
  if (cd && cdDoc && !out.some((o) => o.id === cdDoc)) out.push({ id: cdDoc, kind: "closing_disclosure_final", sha256: S(cd.data["figures_hash"]) ?? S(cd.data["sha256"]) ?? "", custody: "platform" });
  if (out.length) prov.table("documents", `documents:${rows.map((r) => r.id).join(",")}${rec.entities("closing_documents").length ? `; closing_documents:${rec.entities("closing_documents").map((d) => d.id).join(",")}` : ""}`, "35.2"); else prov.gap("documents", "no 35.2 documents rows for the application");
  return out;
}

/** Rule 6: the snapshot from the record. `rec` may be handed in (the pass's transaction-bound record) or loaded here. */
export async function buildFundingSnapshot(rt: Runtime, applicationId: string, o: { now: string; actor: Actor; persist: boolean; rec?: OrchRecord }): Promise<SnapshotBuild> {
  const app = await rt.applications.get(applicationId); if (!app) throw new RangeError(`no application ${applicationId}`);
  const rec = o.rec ?? await loadRecord(rt, app, app.loan_id ?? null);
  const environment = environmentOf(rt);
  const prov = new Provenance();
  const closing = closingFacts(rec);
  const parties = closing ? await partyFacts(rec, closing) : null;
  const terms = (() => { try { return loanTerms(rec); } catch (e) { if (e instanceof RecordGap) { prov.gap("note", e.message); return null; } throw e; } })();
  const partnerName = parties?.partner_legal_name ?? (await rt.db.query<{ n: string; m: string | null }>(`SELECT legal_name AS n, mers_org_id AS m FROM parties WHERE id = $1`, [app.partner_party_id]))[0]?.n ?? "";
  const partnerOrg = parties?.partner_mers_org_id ?? (await rt.db.query<{ m: string | null }>(`SELECT mers_org_id AS m FROM parties WHERE id = $1`, [app.partner_party_id]))[0]?.m ?? "";
  prov.table("partner", `parties:${app.partner_party_id}`, "21.1");
  const purchase = app.transaction_type === "purchase";
  // ── the note: 26.1's eNote/note row (data_hash) + the note terms 26.1 snapshotted (closing_data_snapshots.payload.note_terms) + 26.2's consummation note date
  const noteDoc = rec.entities("closing_documents", (d) => d["kind"] === "enote" || d["kind"] === "note").at(-1) ?? null;
  const setRow = rec.entities("closing_document_sets").at(-1) ?? null;
  const snapRow = setRow?.data["snapshot_id"] ? rec.entity("closing_data_snapshots", String(setRow.data["snapshot_id"])) ?? null : rec.entities("closing_data_snapshots").at(-1) ?? null;
  const noteTerms = ((snapRow?.data["payload"] as Row | undefined)?.["note_terms"] as Row | undefined) ?? null;
  const consummated = rec.last("closing.consummated");
  const funded = rec.last("loan.funded");
  const product = terms ? productFacts(rec, terms) : null;
  const noteDate = S(consummated?.payload["note_date"]) ?? closing?.scheduled_note_date ?? null;
  let note: OriginationSnapshot["note"] | null = null;
  if (noteDoc && noteTerms && terms && noteDate && parties) {
    note = { document_id: noteDoc.id, data_hash: String(noteDoc.data["data_hash"] ?? ""), note_date: D(noteDate), amount_cents: cents(noteTerms["principal_cents"]), note_rate_pct: String(noteTerms["note_rate_pct"]), term_months: Number(noteTerms["term_months"]), first_payment_date: D(String(noteTerms["first_payment_date"])), maturity_date: D(String(noteTerms["maturity_date"])), late_charge_pct: String(noteTerms["late_charge_pct"]), late_charge_grace_days: Number(noteTerms["late_charge_days"] ?? noteTerms["late_charge_grace_days"]),
      amortization: product?.amortization ?? "fixed", arm: null, buydown_schedule: null, partner_nmlsr_id: parties.partner_nmlsr_id, mlo_nmlsr_id: parties.mlo_nmlsr_id, security_instrument_version: String((snapRow?.data["payload"] as Row | undefined)?.["security_instrument_version"] ?? "uniform_2021") } as OriginationSnapshot["note"];
    prov.entity("note", "closing_documents", noteDoc.id, noteDoc.version, "26.1"); prov.entity("note.terms", "closing_data_snapshots", snapRow!.id, snapRow!.version, "26.1"); if (consummated) prov.event("note.note_date", consummated, "26.2");
  } else if (!prov.gaps.includes("note")) prov.gap("note", `26.1's note row ${noteDoc ? "present" : "missing"}, note terms ${noteTerms ? "present" : "missing"}, note date ${noteDate ?? "missing"}`);
  // ── closing: 26.2's consummation, the note's hash, the security instrument
  const si = rec.entities("closing_documents", (d) => d["kind"] === "security_instrument" || d["kind"] === "deed_of_trust" || d["kind"] === "mortgage").at(-1) ?? null;
  let closingOut: OriginationSnapshot["closing"] | null = null;
  if (consummated && noteDoc) { closingOut = { consummation_date: D(String(consummated.payload["consummation_on"] ?? consummated.payload["note_date"])), note_terms_hash: String(noteDoc.data["data_hash"] ?? ""), security_instrument_document_id: si?.id ?? null }; prov.event("closing", consummated, "26.2"); if (si) prov.entity("closing.security_instrument_document_id", "closing_documents", si.id, si.version, "26.1"); }
  else prov.gap("closing", `closing.consummated ${consummated ? "present" : "missing"}; note row ${noteDoc ? "present" : "missing"}`);
  // ── final CD: the version disclosure.cd.consummated names in 25.2's row; prepaid interest from loan.funded; the compliance gate from 25.1
  const cdConsummated = rec.last("disclosure.cd.consummated"); const cd = cdConsummated ? rec.entity("disclosures", String(cdConsummated.payload["disclosure_id"])) ?? cdRow(rec) : cdRow(rec);
  const gateRun = rec.last("compliance.gate.opened", (p) => p["gate"] === "disbursement") ?? rec.last("compliance.gate.opened", (p) => p["gate"] === "cd");
  let finalCd: OriginationSnapshot["final_cd"] | null = null;
  if (cd && funded) {
    const f = (cd.data["figures"] as Row | undefined) ?? {}; const loan = (f["loan"] as Row | undefined) ?? {}; const esc = (f["escrow"] as Row | undefined) ?? {};
    const docId = S(cd.data["document_id"]) ?? S(cd.data["pdf_document_id"]) ?? cd.id;
    finalCd = { document_id: docId, pi_cents: cents(loan["pi_cents"] ?? f["pi_cents"]), monthly_escrow_cents: cents(esc["monthly_escrow_cents"] ?? f["monthly_escrow_cents"]), initial_escrow_deposit_cents: cents(esc["initial_escrow_payment_cents"] ?? f["initial_escrow_payment_cents"]), prepaid_interest_cents: cents(funded.payload["prepaid_interest_cents"]), prepaid_interest_days: Number(funded.payload["prepaid_days"] ?? 0), compliance_tests_passed: !!gateRun };
    prov.entity("final_cd", "disclosures", cd.id, cd.version, "25.2"); if (cdConsummated) prov.event("final_cd.version", cdConsummated, "25.2"); prov.event("final_cd.prepaid_interest", funded, "26.3"); if (gateRun) prov.event("final_cd.compliance_tests_passed", gateRun, "25.1"); else prov.gap("final_cd.compliance_tests_passed", "no compliance.gate.opened run for the CD or the disbursement (25.1)");
  } else prov.gap("final_cd", `CD row ${cd ? "present" : "missing"}; loan.funded ${funded ? "present" : "missing"}`);
  // ── escrow analysis: 30.3's frozen row (the refresh at funding cites it when it has run)
  const analysis = rec.entities("escrow_analyses", (d) => d["source"] === "origination" && d["status"] === "frozen").at(-1) ?? null;
  const refreshed = rec.last("escrow.initial_analysis.refreshed_at_funding");
  const hpmlEv = rec.last("compliance.hpml.determined"); const hpml = hpmlEv?.payload["is_hpml"] === true;
  let escrow: OriginationSnapshot["escrow_analysis"] = null;
  if (analysis) {
    // 30.3's row as the engine wrote it: the CD single-item lines (annual and per-month cents per item), the base payment (the monthly escrow), the required start balance and the cushion (their sum is the (g)(3) deposit)
    const a = analysis.data; const l7 = ((a["cd_figures"] as Row | undefined)?.["l7"] as Row | undefined) ?? {};
    const single = ((a["single_item_lines"] as Row[] | undefined) ?? (((a["cd_figures"] as Row | undefined)?.["g3"] as Row | undefined)?.["lines"] as Row[] | undefined) ?? []);
    const lines = single.length ? single.map((l) => ({ line_type: String(((l["line_types"] as unknown[] | undefined) ?? [])[0] ?? l["item"]), annual_amount_cents: cents(l["annual_cents"]), monthly_cents: cents(l["per_month_cents"]) }))
      : ((a["lines"] as Row[] | undefined) ?? []).map((l) => ({ line_type: String(l["line_type"]), annual_amount_cents: cents(l["estimated_annual_cents"] ?? l["annual_amount_cents"]), monthly_cents: cents(l["monthly_cents"] ?? 0) }));
    escrow = { source: "origination", type: "initial", required_start_balance_cents: cents(a["required_start_balance_cents"]), cushion_cents: cents(a["cushion_cents"]), monthly_escrow_cents: cents(a["base_payment_cents"] ?? l7["monthly_escrow_payment_cents"]), lines, status: "active", ...(hpml ? { hpml_escrow_min_cancel_date: isDate(hpmlEv?.payload["escrow_min_cancel_date"]) ? D(String(hpmlEv!.payload["escrow_min_cancel_date"])) : null } : {}) };
    prov.entity("escrow_analysis", "escrow_analyses", analysis.id, analysis.version, "30.3"); if (refreshed) prov.event("escrow_analysis.refreshed_at_funding", refreshed, "30.3");
  } else if (escrowFacts(rec) === null && rec.has("escrow.waived")) { prov.event("escrow_analysis", rec.last("escrow.waived")!, "30.3"); }
  else prov.gap("escrow_analysis", "no frozen origination escrow_analyses row (30.3 freeze)");
  // ── HPML / QM / LTV
  if (hpmlEv) prov.event("hpml", hpmlEv, "23.4"); else prov.gap("hpml", "no compliance.hpml.determined (23.4)");
  const qmEv = rec.last("compliance.qm.determined"); if (qmEv) prov.event("qm_type", qmEv, "23.4"); else prov.gap("qm_type", "no compliance.qm.determined (23.4)");
  let ltv: string | null = null; try { const l = ltvPct(rec); ltv = l.value.toFixed(2); prov.sources["ltv_pct"] = l.source; } catch (e) { if (e instanceof RecordGap) prov.gap("ltv_pct", e.message); else throw e; }
  // ── MI: 24.6's certificate when LTV > 80, else none (the LTV is the source)
  const mi = rec.entities("mi_certificates", (d) => ["active", "activation_requested", "committed", "issued"].includes(String(d["status"]))).at(-1) ?? rec.entities("mi_certificates").at(-1) ?? null;
  let miOut: OriginationSnapshot["mi"] = null;
  if (mi) { const d = mi.data; miOut = { certificate_number: S(d["certificate_number"]), status: String(d["status"]), coverage_pct: String(d["coverage_pct"] ?? ""), premium_plan: String(d["premium_plan"] ?? ""), monthly_premium_cents: cents(d["monthly_premium_cents"]), hpa_disclosure_kind: S(d["hpa_disclosure_kind"]) }; prov.entity("mi", "mi_certificates", mi.id, mi.version, "24.6"); }
  else if (ltv !== null && Number(ltv) <= 80 && prov.sources["ltv_pct"]) prov.sources["mi"] = { ...prov.sources["ltv_pct"], ref: `${prov.sources["ltv_pct"].ref} (LTV ${ltv} ≤ 80: no MI)` };
  else prov.gap("mi", "LTV above 80 and no mi_certificates row (24.6)");
  // ── hazard: 24.5's verified hazard policy (26.3's FC_HAZARD item reads the same event)
  const hazard = rec.last("insurance.policy.verified", (p) => p["policy_kind"] === "hazard" || p["kind"] === "hazard");
  let hazardOut: OriginationSnapshot["hazard"] | null = null;
  if (hazard && isDate(hazard.payload["expiration_date"])) { hazardOut = { verified: true, mortgagee_clause_partner_isaoa_co_sm: hazard.payload["mortgagee_clause_partner_isaoa_co_sm"] === true, expires_on: D(String(hazard.payload["expiration_date"])) }; prov.event("hazard", hazard, "24.5"); }
  else prov.gap("hazard", "no insurance.policy.verified{hazard} with an expiration date (24.5)");
  // ── flood: 24.5's determination, LOL enrollment, coverage
  const flood = rec.last("flood.determination.received"); const lol = rec.last("flood.lol.enrolled"); const floodCov = rec.last("flood.coverage.verified");
  let floodOut: OriginationSnapshot["flood"] | null = null;
  const floodRow = rec.entities("flood_determinations").at(-1) ?? null;
  if (flood) { const sfha = flood.payload["sfha"] === true || flood.payload["in_sfha"] === true; floodOut = { determination_present: true, lol_purchased: !!lol || flood.payload["lol_purchased"] === true || floodRow?.data["lol_purchased"] === true, lol_contract_linked: lol?.payload["contract_linked"] === true || floodRow?.data["lol_contract_linked"] === true, sfha, policy_verified: !!floodCov }; prov.event("flood", flood, "24.5"); if (lol) prov.event("flood.lol", lol, "24.5"); else if (floodRow) prov.entity("flood.lol", "flood_determinations", floodRow.id, floodRow.version, "24.5"); if (floodCov) prov.event("flood.policy", floodCov, "24.5"); }
  else prov.gap("flood", "no flood.determination.received (24.5)");
  // ── MIN and custody: 26.2's eNote registration (Controller = the partner) or 26.4's MIN; paper custody from 26.2's seed
  const registered = rec.last("enote.registered"); const minReg = rec.last("mers.min.registered"); const enoteRow = rec.entities("enotes").at(-1) ?? null;
  const custodyKind: "paper" | "enote" = closing?.note_form === "enote" || !!registered ? "enote" : "paper";
  let min: OriginationSnapshot["min"] | null = null;
  if (registered) { min = { value: String(registered.payload["min"]), registration: "active" }; prov.event("min", registered, "26.2"); }
  else if (minReg) { min = { value: String(minReg.payload["min"]), registration: minReg.payload["status"] === "active" ? "active" : "pending" }; prov.event("min", minReg, "26.4"); }
  else if (closing && S(rec.payload("closing.scheduled")?.["min"])) { min = { value: S(rec.payload("closing.scheduled")?.["min"]), registration: "pre_closing" }; prov.event("min", rec.last("closing.scheduled")!, "26.2"); }
  else prov.gap("min", "no enote.registered, mers.min.registered or scheduled MIN (26.2/26.4)");
  let custody: OriginationSnapshot["custody"] | null = null;
  const seeded = rec.last("custody.record.seeded");
  if (custodyKind === "enote" && registered) { custody = { kind: "enote", enote_registered_at: String(registered.payload["registered_at"] ?? registered.occurredAt), controller: registered.payload["controller"] === "partner" ? app.partner_party_id : S(registered.payload["controller_org_id"]), status: "registered", custodian: S(registered.payload["location"]) }; prov.event("custody", registered, "26.2"); }
  else if (seeded) {
    // 26.2's paper chain: the seed at the settlement agent, the courier's pickup (`custody.paper_note.shipped`), the custodian's receipt (`custody.paper_note.received`) — 30.2's OB-015 boards a shipped or received note
    const shipped = rec.last("custody.paper_note.shipped"); const received = rec.last("custody.paper_note.received");
    custody = { kind: "paper", custodian: S(received?.payload["custodian_party_id"]) ?? S(seeded.payload["custodian_party_id"]), status: received ? "received" : shipped ? "shipped" : String(seeded.payload["note_location"] ?? "settlement_agent") };
    prov.event("custody", received ?? shipped ?? seeded, "26.2");
  }
  else prov.gap("custody", `no ${custodyKind === "enote" ? "enote.registered" : "custody.record.seeded"} (26.2)`);
  void enoteRow;
  // ── warehouse advance
  const advanceFunded = rec.last("warehouse.advance.funded");
  if (advanceFunded) prov.event("warehouse_advance_id", advanceFunded, "27.1"); else prov.gap("warehouse_advance_id", "no warehouse.advance.funded (27.1)");
  // ── borrowers, consents, documents, property, trailing, parcel, statement, autopay
  const borrowers = await borrowersFromRecord(rt, rec, prov);
  const cons = await consentsFromRecord(rt, rec, partnerName, prov);
  const documents = await documentsFromRecord(rt, rec, closing, custodyKind, prov);
  const subject = (await rt.db.query<{ id: string; address_line1: string | null; city: string | null; state: string | null; postal_code: string | null; county: string | null; property_type: string | null; units: number | null; estimated_value_cents: string | null }>(`SELECT id::text AS id, address_line1, city, state, postal_code, county, property_type, units, estimated_value_cents::text AS estimated_value_cents FROM application_properties WHERE application_id = $1 ORDER BY is_subject DESC, created_at LIMIT 1`, [rec.app.id]))[0] ?? null;
  const appraisal = [...rec.entities("appraisals", (d) => d["review_status"] !== "rejected")].sort((a, b) => Number(a.data["version_no"] ?? 0) - Number(b.data["version_no"] ?? 0)).at(-1) ?? null;
  const valuation = rec.last("valuation.review.completed", (p) => p["is_final_version"] !== false) ?? rec.last("valuation.received", (p) => p["declined"] !== true);
  const appraised = appraisal ? cents(appraisal.data["appraised_value_cents"]) : valuation ? cents(valuation.payload["appraised_value_cents"] ?? valuation.payload["value_cents"] ?? 0) : 0n;
  const commitment = rec.last("title.commitment.received");
  let property: OriginationSnapshot["property"] | null = null;
  if (subject) {
    if (appraisal && appraised > 0n) prov.entity("property.appraised_value_cents", "appraisals", appraisal.id, appraisal.version, "24.2"); else if (appraised > 0n) prov.event("property.appraised_value_cents", valuation!, "24.1"); else prov.gap("property.appraised_value_cents", "no 24.2 appraisals row with a value");
    property = { address_line1: subject.address_line1, city: subject.city, state: subject.state, postal_code: subject.postal_code, county: subject.county ?? parties?.county ?? null, apn: S(commitment?.payload["apn"]) ?? parties?.apn ?? null, property_type: subject.property_type ?? rec.propertyType() ?? "sfr", units: subject.units ?? 1, occupancy: app.occupancy ?? "primary", flood_zone: S(flood?.payload["zone"]), sfha: floodOut?.sfha ?? false, appraised_value_cents: appraised, original_value_cents: purchase ? (cents(rec.payload("application.trid_received")?.["sales_price_cents"] ?? 0) || appraised) : appraised } as OriginationSnapshot["property"];
    prov.table("property", `application_properties:${subject.id}`, "21.1"); if (commitment) prov.event("property.apn", commitment, "24.4");
  } else prov.gap("property", "no application_properties subject row (21.1)");
  const trailingRows = await rt.db.query<{ kind: string; status: string; received_at: string | null }>(`SELECT kind, status, received_at::text AS received_at FROM trailing_documents WHERE application_id = $1`, [rec.app.id]);
  const trailing = { recorded_security_instrument_received: trailingRows.some((t) => /recorded_security_instrument|recorded_mortgage|recorded_deed/.test(t.kind) && !!t.received_at), final_title_policy_received: trailingRows.some((t) => /final_title_policy/.test(t.kind) && !!t.received_at) };
  prov.table("trailing", `trailing_documents:application_id=${rec.app.id} (${trailingRows.length} rows)`, "26.4");
  const parcel = rec.entities("tax_parcels").find((p) => !property?.apn || p.data["apn"] === property.apn || p.id === property.apn) ?? rec.entities("tax_parcels").at(-1) ?? null;
  const parcelVerified = !!parcel; if (parcel) prov.entity("tax_service_parcel_verified", "tax_parcels", parcel.id, parcel.version, "24.4"); else prov.derived("tax_service_parcel_verified", "no tax_parcels row (24.4 lookupParcel not run): unverified", "24.4");
  const stmtSent = rec.last("escrow.statement.sent"); const stmtRow = rec.entity("disclosures", `initial_escrow_stmt:${rec.app.id}`);
  const stmtDelivered = !!stmtSent || !!stmtRow?.data["delivered_at"];
  if (stmtSent) prov.event("initial_escrow_statement_delivered", stmtSent, "30.3"); else if (stmtRow) prov.entity("initial_escrow_statement_delivered", "disclosures", stmtRow.id, stmtRow.version, "30.3"); else prov.derived("initial_escrow_statement_delivered", "no initial escrow statement on the record (30.3): not delivered", "30.3");
  // rescission: 26.2's closing row and 26.3's funding calendar
  const rescindable = closing ? closing.rescindable : !purchase;
  const rescissionExpires = S(funded?.payload["rescission_expires_at"]) ?? S(rec.payload("funding.calendar.computed")?.["rescission_expires_at"]) ?? null;
  if (closing) prov.entity("rescindable", "closings", closing.row.id, closing.row.version, "26.2"); else prov.gap("rescindable", "no closing.scheduled (26.2)");
  if (funded) prov.event("rescission_expires_at", funded, "26.3"); else prov.gap("rescission_expires_at", "no loan.funded (26.3)");
  if (!funded) prov.gap("loan_funded", "no loan.funded on the record (26.3)");

  // ── assemble; in nonprod a gap is filled from demoSnapshot (fixture_used); the fixture is never read when the record is complete
  const gaps = [...prov.gaps];
  const fixture = gaps.length && environment !== "production" ? demoSnapshot(app, { partner_name: partnerName }) : null;
  let fixtureTaken = false;
  const fill = <K extends keyof OriginationSnapshot>(k: K, v: OriginationSnapshot[K] | null): OriginationSnapshot[K] => { if (v !== null) return v; if (fixture) { fixtureTaken = true; return fixture[k]; } return null as unknown as OriginationSnapshot[K]; };
  const fx = <T,>(v: T | null | undefined, k: keyof OriginationSnapshot): T | null => { if (v !== null && v !== undefined) return v; if (fixture) { fixtureTaken = true; return fixture[k] as unknown as T; } return null; };
  const snapshot: OriginationSnapshot = {
    application_id: app.id, partner_id: app.partner_party_id, partner_name: partnerName, partner_mers_org_id: partnerOrg,
    loan_purpose: purchase ? "purchase" : "refinance", rescindable, rescission_expires_at: rescissionExpires,
    note: fill("note", note), closing: fill("closing", closingOut), final_cd: fill("final_cd", finalCd), escrow_analysis: escrow ?? (gaps.includes("escrow_analysis") ? fx(null, "escrow_analysis") : null),
    hpml, qm_type: S(qmEv?.payload["qm_type"]) ?? fx(null, "qm_type") ?? "", ltv_pct: ltv ?? fx(null, "ltv_pct") ?? "",
    mi: miOut ?? (gaps.includes("mi") ? fx(null, "mi") : null), hazard: fill("hazard", hazardOut), flood: fill("flood", floodOut), min: fill("min", min), custody: fill("custody", custody),
    warehouse_advance_id: S(advanceFunded?.payload["advance_id"]) ?? fx(null, "warehouse_advance_id"),
    borrowers: borrowers.length ? borrowers : (fx(null, "borrowers") ?? []), consents: cons.consents.length ? cons.consents : (gaps.includes("consents") ? fx(null, "consents") ?? [] : []), disclosure_versions: Object.keys(cons.versions).length ? cons.versions : (fx(null, "disclosure_versions") ?? {}),
    property: fill("property", property), documents: documents.length ? documents : (fx(null, "documents") ?? []), trailing, tax_service_parcel_verified: parcelVerified, initial_escrow_statement_delivered: stmtDelivered, ach_autopay_elected: cons.ach,
  };
  const fixtureUsed = fixtureTaken;
  const refused = environment === "production" && gaps.length ? "FIXTURE_REFUSED" : null;
  const stored = redactForStorage(snapshot); const hash = snapshotHash(stored);
  const orch = await orchestrationByApplication(rt.db, app.id);
  const escalations: SnapshotEscalation[] = refused ? [
    { kind: "ops_analyst", ownerRole: "ops_analyst", severity: "sev2", payload: { reason: "FIXTURE_REFUSED", application_id: app.id, gaps, environment } },
    { kind: "compliance", ownerRole: "compliance", severity: "sev2", payload: { reason: "FIXTURE_REFUSED", application_id: app.id, gaps, environment, rule: "35.6 rule 6: no fixture in production" } }] : [];
  let snapshotId: string | null = null; let eventId: string | null = null;
  if (o.persist) {
    const row = await rt.db.query<{ id: string }>(`INSERT INTO funding_snapshots (application_id, orchestration_id, snapshot_hash, snapshot, sources, gaps, fixture_used, environment, built_at, built_by, refused_code) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::text[], $7, $8, $9, $10::jsonb, $11) RETURNING id::text AS id`,
      [app.id, orch?.id ?? null, hash, JSON.stringify(canonical(stored)), JSON.stringify(prov.sources), gaps, fixtureUsed, environment, o.now, JSON.stringify({ kind: o.actor.kind, id: o.actor.id, role: (o.actor as { role?: string }).role ?? null }), refused]);
    snapshotId = row[0]!.id;
    const r = await rt.uow.run({ applicationId: app.id, ...(rec.loanId ? { loanId: rec.loanId } : {}) }, (ctx) => ctx.events.append({ type: EV.snapshotBuilt, applicationId: app.id, ...(rec.loanId ? { loanId: rec.loanId } : {}), aggregate: { kind: "funding_snapshot", id: snapshotId! }, actor: ORCH_ACTOR, occurredAt: o.now, payload: { snapshot_id: snapshotId, application_id: app.id, orchestration_id: orch?.id ?? null, snapshot_hash: hash, gaps, fixture_used: fixtureUsed, environment, refused_code: refused, sources: Object.keys(prov.sources).length } }), { clock: rt.clock });
    eventId = r.events[0]?.id ?? null;
  }
  return { snapshot_id: snapshotId, orchestration_id: orch?.id ?? null, snapshot_hash: hash, gaps, fixture_used: fixtureUsed, environment, refused_code: refused, sources: prov.sources, snapshot, escalations, event_id: eventId };
}

// ───────────────────────────── the hand-off from the stored snapshot ─────────────────────────────
export interface FundFromSnapshotResult extends FundApplicationResult { readonly snapshot_id: string; readonly snapshot_hash: string; readonly overridden: readonly string[] }
export async function fundFromSnapshot(rt: Runtime, applicationId: string, o: { now: string; actor: Actor; snapshot_id: string | null; overrides: Record<string, unknown> | null }): Promise<FundFromSnapshotResult> {
  const cols = `id::text AS id, snapshot, snapshot_hash, gaps, refused_code, fixture_used`;
  const row = (o.snapshot_id
    ? await rt.db.query<{ id: string; snapshot: unknown; snapshot_hash: string; gaps: string[]; refused_code: string | null; fixture_used: boolean }>(`SELECT ${cols} FROM funding_snapshots WHERE id = $1 AND application_id = $2`, [o.snapshot_id, applicationId])
    : await rt.db.query<{ id: string; snapshot: unknown; snapshot_hash: string; gaps: string[]; refused_code: string | null; fixture_used: boolean }>(`SELECT ${cols} FROM funding_snapshots WHERE application_id = $1 ORDER BY built_at DESC, created_at DESC LIMIT 1`, [applicationId]))[0];
  if (!row) throw new SnapshotRefused("SNAPSHOT_GAP", `no funding_snapshots row for application ${applicationId} — orchestration.snapshot builds it from the record (rule 6)`);
  if (row.refused_code) throw new SnapshotRefused(row.refused_code, `hand-off refused ${row.refused_code}: the record cannot supply ${row.gaps.join(", ")} and ${environmentOf(rt)} fills no gap from a fixture (35.6 rule 6)`, row.gaps);
  const base = reviveSnapshot(row.snapshot) as OriginationSnapshot;
  const overridden: string[] = [];
  let snapshot = base;
  if (o.overrides && Object.keys(o.overrides).length) {
    const o2 = reviveSnapshot(o.overrides) as Partial<OriginationSnapshot>;
    for (const k of Object.keys(o2)) overridden.push(k);
    snapshot = { ...base, ...o2, application_id: base.application_id, partner_id: base.partner_id };
  }
  const funded = await fundedFromLog(rt, applicationId);
  if (!funded) throw new SnapshotRefused("NO_LOAN_FUNDED", `no loan.funded on the application's log (26.3's confirmDisbursement) — the hand-off has nothing to board`);
  const r = await fundApplication(rt, applicationId, await rehydrate(rt, applicationId, snapshot), funded, o.actor);
  let snapshotId = row.id; let hash = row.snapshot_hash;
  if (overridden.length && !r.duplicate) {
    // the replacement row: the officer's corrected snapshot as the hand-off used it (the overridden paths sourced to the officer), linked to 30.2's loan.staged
    const stored = redactForStorage(snapshot); hash = snapshotHash(stored);
    const staged = (await rt.db.query<{ id: string }>(`SELECT id::text AS id FROM loan_events WHERE application_id = $1 AND type = 'loan.staged' ORDER BY sequence DESC LIMIT 1`, [applicationId]))[0]?.id ?? null;
    const prior = (await rt.db.query<{ sources: Record<string, Source>; orchestration_id: string | null; environment: string; fixture_used: boolean }>(`SELECT sources, orchestration_id::text AS orchestration_id, environment, fixture_used FROM funding_snapshots WHERE id = $1`, [row.id]))[0]!;
    const sources = { ...prior.sources, ...Object.fromEntries(overridden.map((k) => [k, src("derived", `officer override (${o.actor.kind}:${o.actor.id}) replacing funding_snapshots:${row.id}`, "35.6")])) };
    const ins = await rt.db.query<{ id: string }>(`INSERT INTO funding_snapshots (application_id, orchestration_id, snapshot_hash, snapshot, sources, gaps, fixture_used, environment, built_at, built_by, fund_event_id, refused_code) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::text[], $7, $8, $9, $10::jsonb, $11, NULL) RETURNING id::text AS id`,
      [applicationId, prior.orchestration_id, hash, JSON.stringify(canonical(stored)), JSON.stringify(sources), [], prior.fixture_used, prior.environment, o.now, JSON.stringify({ kind: o.actor.kind, id: o.actor.id, role: (o.actor as { role?: string }).role ?? null }), staged]);
    snapshotId = ins[0]!.id;
  }
  return { ...r, snapshot_id: snapshotId, snapshot_hash: hash, overridden };
}
export type { PlainDate };
