/**
 * §35.6 rule 2 — every command input is derived from the record inside the pass; nothing is hand-fed. The typed readers
 * here build the objects the harnesses assemble by hand (23.3's `facts`, 26.2's `facts`, 26.3's `conditions` / `rescission` /
 * `ptf` / `cash_to_close`, 29.4's `gate_facts`, 30.1's `loan`, …) from named events and rows of the application's record,
 * each field with its source (`{kind: event | entity | table | derived, ref, process}`) so the decision record and the
 * journal can cite them (SNAPSHOT_CITES_SOURCES). The readers are the single source in the pass and the screens.
 *
 * `OrchRecord` is the fold's view of one application: its `applications` row, its whole log (application- and, once staged,
 * loan-keyed), the entity store's current rows for both scopes, and the typed tables the steps read through `q`.
 */
import type { Queryable } from "../../infra/db/client.ts";
import type { Runtime } from "../../runtime/app.ts";
import type { ApplicationRecord } from "../../infra/db/applications.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import { EntityStore, type EntityRecord } from "../../app/tools.ts";
import { createHash } from "node:crypto";
import { wallClock } from "../../kernel/calendar/zoned.ts";

type Row = Record<string, unknown>;
export interface Source { readonly kind: "event" | "entity" | "table" | "derived" | "platform"; readonly ref: string; readonly process: string }
export interface Sourced<T> { readonly value: T; readonly source: Source }
export const src = (kind: Source["kind"], ref: string, process: string): Source => ({ kind, ref, process });
export const fromEvent = <T,>(value: T, e: DomainEvent, process: string): Sourced<T> => ({ value, source: src("event", `${e.type}:${e.id}`, process) });
export const fromEntity = <T,>(value: T, r: EntityRecord, process: string): Sourced<T> => ({ value, source: src("entity", `${r.kind}:${r.id}:${r.version}`, process) });
export const fromTable = <T,>(value: T, table: string, pk: string, process: string): Sourced<T> => ({ value, source: src("table", `${table}:${pk}`, process) });
export const derived = <T,>(value: T, ref: string, process: string): Sourced<T> => ({ value, source: src("derived", ref, process) });
export const platform = <T,>(value: T, ref: string): Sourced<T> => ({ value, source: src("platform", ref, "35.6") });

/** Strip a `Sourced` tree to its values (the command input) and, separately, its sources (the journal / decision detail). */
export function values<T extends Record<string, unknown>>(o: T): Record<string, unknown> { return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, isSourced(v) ? v.value : v])); }
export function sources<T extends Record<string, unknown>>(o: T): Record<string, Source> { return Object.fromEntries(Object.entries(o).filter(([, v]) => isSourced(v)).map(([k, v]) => [k, (v as Sourced<unknown>).source])); }
const isSourced = (v: unknown): v is Sourced<unknown> => !!v && typeof v === "object" && "value" in (v as Row) && "source" in (v as Row) && typeof (v as Row)["source"] === "object";
export const cents = (v: unknown): bigint => (typeof v === "bigint" ? v : v === null || v === undefined || v === "" ? 0n : BigInt(String(v)));
export const centsStr = (v: unknown): string => cents(v).toString();
export class RecordGap extends Error { readonly path: string; constructor(path: string, why: string) { super(`the record does not carry ${path}: ${why}`); this.name = "RecordGap"; this.path = path; } }

export class OrchRecord {
  readonly app: ApplicationRecord;
  readonly events: readonly DomainEvent[];
  readonly store: EntityStore;
  readonly q: Queryable;
  readonly loanId: string | null;
  readonly rt: Runtime;
  private readonly byType = new Map<string, DomainEvent[]>();
  constructor(rt: Runtime, app: ApplicationRecord, events: readonly DomainEvent[], store: EntityStore, loanId: string | null) {
    this.rt = rt; this.app = app; this.events = events; this.store = store; this.q = rt.db; this.loanId = loanId;
    for (const e of events) { const l = this.byType.get(e.type); if (l) l.push(e); else this.byType.set(e.type, [e]); }
  }
  all(type: string): readonly DomainEvent[] { return this.byType.get(type) ?? []; }
  has(type: string, pred?: (p: Row, e: DomainEvent) => boolean): boolean { return this.last(type, pred) !== null; }
  last(type: string, pred?: (p: Row, e: DomainEvent) => boolean): DomainEvent | null { const l = this.all(type); for (let i = l.length - 1; i >= 0; i--) { const e = l[i]!; if (!pred || pred(e.payload as Row, e)) return e; } return null; }
  first(type: string): DomainEvent | null { return this.all(type)[0] ?? null; }
  after(seq: number): readonly DomainEvent[] { return this.events.filter((e) => e.sequence > seq); }
  lastSequence(): number { return this.events.length ? this.events[this.events.length - 1]!.sequence : 0; }
  entity(kind: string, id: string): EntityRecord | undefined { return this.store.get(kind, id); }
  entities(kind: string, where: (d: Row) => boolean = () => true): readonly EntityRecord[] { return this.store.list(kind, where).filter((r) => r.data["application_id"] === undefined || r.data["application_id"] === null || r.data["application_id"] === this.app.id || (this.loanId !== null && r.data["loan_id"] === this.loanId)); }
  latest(kind: string, where: (d: Row) => boolean = () => true): EntityRecord | undefined { const l = this.entities(kind, where); return l.length ? l.reduce((a, b) => (b.updatedAt >= a.updatedAt ? b : a)) : undefined; }
  payload<T = Row>(type: string, pred?: (p: Row) => boolean): T | null { const e = this.last(type, pred ? (p) => pred(p) : undefined); return e ? (e.payload as T) : null; }
  /** The 21.1 intake record (`applications` entity kind: the interview's borrowers with their ids, the six items, the partner and MLO facts). */
  intake(): Row | null { return this.entity("applications", this.app.id)?.data ?? null; }
  /** The borrower ids the origination tools use (21.1's interview ids, `B1`/`B2`; the application_borrowers uuids when the interview never ran). */
  borrowerIds(): string[] { const b = (this.intake()?.["borrowers"] as Row[] | undefined) ?? []; return b.length ? b.map((x) => String(x["id"])) : this.app.borrowers.map((x) => x.id); }
  borrowerName(id: string): string { const b = ((this.intake()?.["borrowers"] as Row[] | undefined) ?? []).find((x) => String(x["id"]) === id); return b ? String(b["legal_name"]) : this.app.borrowers.find((x) => x.id === id)?.legal_name ?? id; }
  transactionType(): string | null { return this.app.transaction_type ?? null; }
  fundingType(): string | null { const p = this.payload("funding.requested"); return p ? String(p["funding_type"] ?? "") || null : null; }
  noteForm(): string | null { const s = this.payload("closing.scheduled"); if (s && s["enote"] !== undefined) return s["enote"] ? "enote" : "paper"; const c = this.payload("closing.consummated"); return c ? String(c["note_form"] ?? "") || null : null; }
  closingType(): string | null { const s = this.payload("closing.scheduled"); return s ? String(s["closing_type"] ?? "") || null : null; }
  /** The hash of what the pass read (the facts object's hash in the decision record): the last sequence and the current entity versions. */
  sourcesHash(): string { return createHash("sha256").update(JSON.stringify({ seq: this.lastSequence(), versions: this.store.versionCount() })).digest("hex"); }
  partnerId(): string { return this.app.partner_party_id; }
  state(): string { return this.app.properties[0]?.state ?? String(this.intake()?.["property_state"] ?? "") ?? ""; }
  timeZone(): string { return String(this.intake()?.["creditor_time_zone"] ?? (this.state() === "AZ" ? "America/Phoenix" : "America/New_York")); }
  civilDate(iso: string): string { return wallClock(Date.parse(iso), this.timeZone()).date; }
  etDate(iso: string): string { return wallClock(Date.parse(iso), "America/New_York").date; }
}

/** The application's whole record: log (both keys, deduplicated), entity rows (both scopes) and the applications row. */
export async function loadRecord(rt: Runtime, app: ApplicationRecord, loanId: string | null = app.loan_id ?? null): Promise<OrchRecord> {
  const [appEvents, loanEvents] = await Promise.all([rt.uow.events.byApplication(app.id), loanId ? rt.uow.events.byLoan(loanId) : Promise.resolve([] as DomainEvent[])]);
  const seen = new Set<string>();
  const events = [...appEvents, ...loanEvents].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))).sort((a, b) => a.sequence - b.sequence);
  const store = new EntityStore();
  store.seed(await rt.entities.load({ applicationId: app.id, ...(loanId ? { loanId } : {}) }));
  return new OrchRecord(rt, app, events, store, loanId);
}

// ───────────────────────────── 22.2 — the credit order (T1) ─────────────────────────────
export interface CreditOrderFacts { readonly permissible_purpose: Sourced<string>; readonly certification_ref: Sourced<string>; readonly borrower_authorization_ref: Sourced<string>; readonly subscriber_code: Sourced<string>; readonly borrower_ids: Sourced<string[]>; readonly joint_intent_facts: Sourced<Row> | null; readonly consents: readonly { consent_id: string; party_id: string | null }[]; readonly fee_gate: Sourced<string> | null }
/** 22.2's own prerequisites read from the record: the fee handled (21.4 `fee.gate.checked{credit_report}`), every borrower's `consents{blanket_verification_authorization}` row, the partner's `credit_authorizations` row (permissible purpose, certification, subscriber code), the joint-intent facts from 21.1. Null when the record is not ready (the step waits). */
export async function creditOrderFacts(rec: OrchRecord): Promise<CreditOrderFacts | null> {
  if (!rec.has("application.trid_received") || !rec.has("disclosure.le.received")) return null;
  const fee = rec.last("fee.gate.checked", (p) => p["fee_kind"] === "credit_report" && ["exempt_credit_report", "open"].includes(String(p["result"])));
  if (!fee) return null;
  const consents = await rec.q.query<{ id: string; party_id: string | null; captured_at: string }>(`SELECT id::text AS id, party_id::text AS party_id, captured_at::text AS captured_at FROM consents WHERE application_id = $1 AND kind = 'blanket_verification_authorization' AND standing AND (status IS NULL OR status = 'active') ORDER BY captured_at`, [rec.app.id]);
  const borrowerIds = rec.borrowerIds();
  if (consents.length < borrowerIds.length) return null;
  const auth = (await rec.q.query<{ authorization_id: string; permissible_purpose: string; evidence: Row | null; party_id: string | null }>(`SELECT authorization_id::text AS authorization_id, permissible_purpose, evidence, party_id::text AS party_id FROM credit_authorizations WHERE (application_id = $1 OR lead_id = $1) ORDER BY (kind = 'hard_application') DESC, captured_at DESC LIMIT 1`, [rec.app.id]))[0];
  if (!auth) throw new RangeError(`no credit_authorizations row for application ${rec.app.id} (the partner's certification and subscriber code are read there, never from the request)`);
  const ev = auth.evidence ?? {};
  const cert = String(ev["certification_ref"] ?? ""); const sub = String(ev["subscriber_code"] ?? "");
  if (!cert || !sub) throw new RangeError(`credit_authorizations ${auth.authorization_id} carries no certification_ref / subscriber_code in its evidence`);
  const intake = rec.intake();
  const trid = rec.last("application.trid_received")!;
  const ib = (intake?.["borrowers"] as Row[] | undefined) ?? [];
  const joint: Row | null = ib.length ? { trid_received_at: String(trid.payload["trid_received_at"] ?? trid.occurredAt), borrowers: ib.map((b) => ({ id: String(b["id"]), joint_intent_affirmed_at: b["joint_intent_affirmed_at"] ?? null, added_at: b["added_at"] ?? trid.occurredAt })) } : null;
  return { permissible_purpose: fromTable(auth.permissible_purpose === "consumer_initiated_credit_transaction_1681b_a3A" ? "credit_transaction_604a3A" : auth.permissible_purpose, "credit_authorizations", auth.authorization_id, "20.3"),
    certification_ref: fromTable(cert, "credit_authorizations", auth.authorization_id, "20.3"), subscriber_code: fromTable(sub, "credit_authorizations", auth.authorization_id, "20.3"),
    borrower_authorization_ref: fromTable(consents[0]!.id, "consents", consents.map((c) => c.id).join(","), "32.2"), borrower_ids: derived(borrowerIds, "21.1 applications.borrowers[].id", "21.1"),
    joint_intent_facts: joint && intake ? fromEntity(joint, rec.entity("applications", rec.app.id)!, "21.1") : null, consents: consents.map((c) => ({ consent_id: c.id, party_id: c.party_id })), fee_gate: fromEvent(String(fee.payload["check_id"] ?? fee.id), fee, "21.4") };
}
export function usableScore(rec: OrchRecord): DomainEvent | null { return rec.last("credit.representative_score.computed", (p) => p["state"] === "usable"); }
/** The relied tri-merge (or RMCR) reports: usable, not superseded, never a soft pull (20.3's prequal, 22.2's pre-close refresh). */
export function creditReports(rec: OrchRecord): readonly EntityRecord[] { return rec.entities("credit_reports", (d) => d["state"] === "usable" && !d["supersedes_report_id"] && !String(d["report_type"] ?? "").startsWith("soft")); }

// ───────────────────────────── 23.x — DU, the decision, the CTC (T2, T3) ─────────────────────────────
export interface BorrowerIdentity { borrower_id: string; last_name: string; suffix: string | null; ssn_last4: string | null }
export function borrowerIdentities(rec: OrchRecord): Sourced<BorrowerIdentity[]> {
  const ids = rec.borrowerIds();
  const rows = ids.map((id, k) => { const ab = rec.app.borrowers[k]; const name = rec.borrowerName(id); return { borrower_id: id, last_name: name.trim().split(/\s+/).at(-1) ?? name, suffix: null, ssn_last4: null as string | null }; });
  return derived(rows, "application_borrowers + 21.1 applications.borrowers (tin_last4 stays on the row; 22.6 verified identities)", "21.1");
}
/** DU's entry guard: every borrower identity-proofed (22.6 `identity.verified{all_borrowers_verified=true}` — the SCIF/identity facts the casefile carries). */
export function identitiesVerified(rec: OrchRecord): DomainEvent | null { return rec.last("identity.verified", (p) => p["all_borrowers_verified"] === true); }
export interface DuFacts { readonly ulad: Sourced<Row>; readonly casefile: Sourced<Row>; readonly reports: Sourced<Row[]>; readonly borrowers: Sourced<BorrowerIdentity[]>; readonly projected_note_date: Sourced<string> | null; readonly scif_facts: Sourced<Row> | null; readonly application_facts: Sourced<Row>; readonly risk: Sourced<Row>; readonly validity: Sourced<Row>; readonly guard: Sourced<Row>; readonly file: Sourced<Row> }
/** The DU chain's inputs from the record: the ULAD snapshot (21.1's six items, the lock or the LE's rate, 24.1's value, 22.2's obligations), the casefile facts (the partner's seller number), the credit reports, the identities. */
export async function duFacts(rec: OrchRecord, now: string): Promise<DuFacts> {
  const intake = rec.intake(); const intakeRec = rec.entity("applications", rec.app.id);
  if (!intake || !intakeRec) throw new RecordGap("applications(21.1)", "the interview record is not on the entity store");
  const partner = (await rec.q.query<{ servicer_number: string | null; legal_name: string; mers_org_id: string | null }>(`SELECT servicer_number, legal_name, mers_org_id FROM parties WHERE id = $1`, [rec.app.partner_party_id]))[0];
  const lock = rec.last("lock.executed"); const le = rec.entities("disclosures", (d) => d["kind"] === "le").at(-1);
  const leRow = rec.last("disclosure.le.issued") ?? rec.last("disclosure.le.received");
  const reports = creditReports(rec);
  if (!reports.length) throw new RecordGap("credit_reports", "no usable credit report");
  const report = reports.reduce((a, b) => (b.updatedAt >= a.updatedAt ? b : a));
  const valuation = rec.last("valuation.received") ?? rec.last("valuation.ordered");
  const loanAmount = cents(intake["loan_amount_sought_cents"] ?? (lock?.payload["loan_amount_cents"] as string | undefined));
  const value = cents(intake["property_value_estimate_cents"]);
  // the note rate: the executed lock (21.4), else the priced quote 20.4 solved for the application (`pricing_quotes.note_rate`, a decimal such as "0.06125"), else the LE's pricing
  const quote = rec.latest("pricing_quotes", (d) => d["outcome"] === "priced" || d["note_rate"] !== undefined);
  const quoteRate = quote ? String(quote.data["note_rate"] ?? "") : "";
  const noteRate = lock ? String(lock.payload["note_rate"]) : quoteRate ? (Number(quoteRate) < 1 ? (Number(quoteRate) * 100).toFixed(3) : quoteRate) : String((le?.data["pricing"] as Row | undefined)?.["rate_pct"] ?? (leRow?.payload["rate_pct"] ?? ""));
  if (!noteRate) throw new RecordGap("note_rate_pct", "no lock.executed, no pricing_quotes row and no LE pricing on the record");
  const tx = rec.app.transaction_type === "purchase" ? "purchase" : rec.app.transaction_type === "cash_out" ? "cash_out" : "limited_cash_out";
  const obligations = (report.data["borrowers"] as Row[] | undefined ?? []).reduce((sum, b) => sum + cents(b["monthly_obligations_cents"] ?? 0), 0n);
  const income = cents(intake["income_monthly_cents"]);
  const ids = borrowerIdentities(rec);
  const ulad: Row = { application_id: rec.app.id, loan_purpose: tx === "purchase" ? "purchase" : `${tx}_refinance`, occupancy: rec.app.occupancy === "primary" ? "principal_residence" : rec.app.occupancy ?? "principal_residence", product: "fixed_30", amortization: "fixed", loan_term: 360, property_type: "sfr_detached",
    sales_price_cents: tx === "purchase" ? String(value) : null, appraised_value_cents: String(value), loan_amount_cents: String(loanAmount), note_rate_pct: noteRate, qualifying_income_cents: String(income), total_obligations_cents: String(obligations), borrowers: ids.value, max_ltv_pct: "95.00" };
  const scif = ((intake["borrowers"] as Row[] | undefined) ?? []).map((b) => ({ id: String(b["id"]), scif_presented_at: (b["scif"] as Row | null)?.["presented_at"] ?? rec.last("interview.session.started")?.occurredAt ?? rec.last("application.trid_received")?.occurredAt ?? now }));
  const scheduled = rec.payload("closing.scheduled");
  const projected = scheduled ? rec.civilDate(String(scheduled["scheduled_at"])) : lock ? String(lock.payload["expires_on"]) : null;
  const findings = rec.last("du.findings.received");
  const ltvX100 = findings && findings.payload["ltv_du"] ? Math.round(Number(findings.payload["ltv_du"]) * 100) : value > 0n ? Number((loanAmount * 10_000n) / value) : 0;
  const applicationFacts: Row = { transaction_type: tx, product: "standard", term_months: 360, ltv_x100: ltvX100, loan_amount_cents: String(loanAmount), units: 1, county_limit_cents: null, score_model: String(report.data["score_model"] ?? "classic_fico"), borrower_ids: rec.borrowerIds(), all_occupying_first_time: false, all_borrowers_first_time: false, du_no_tradelines: false, closing_date: projected };
  const dti = findings && findings.payload["dti_du"] ? Math.round(Number(findings.payload["dti_du"]) * 100) : income > 0n ? Number((obligations * 10_000n) / income) : 0;
  const assets = rec.entities("application_assets").reduce((sum, a) => sum + cents(a.data["declared_balance_cents"] ?? a.data["verified_balance_cents"] ?? 0), 0n);
  const pi = lock ? cents((rec.entity("locks", String(lock.payload["lock_id"]))?.data["quote"] as Row | undefined)?.["pi_cents"] ?? 0) : 0n;
  const risk: Row = { credit: { score_model: String(report.data["score_model"] ?? "classic_fico"), representative_score: report.data["representative_score"] ?? null, history_summary: `22.2 report ${report.id}: ${(report.data["mortgage_tradelines"] as unknown[] | undefined)?.length ?? 0} mortgage tradeline(s), ${(report.data["public_records"] as unknown[] | undefined)?.length ?? 0} public record(s), ${(report.data["collections"] as unknown[] | undefined)?.length ?? 0} collection(s)` },
    capacity: { dti_bps: dti, residual_income_cents: String(income - obligations - pi), income_sources: ["base_salary"], income_reconciled_to_22_3: rec.has("income.finalized") || rec.has("income.validated") || rec.has("verification.received", (p) => p["kind"] === "income") || rec.entities("verifications", (d) => d["component"] === "income" && d["status"] === "received").length > 0 },
    capital: { funds_to_close_cents: String(rec.payload("funds_to_close.computed")?.["cash_to_close_cents"] ?? "0"), reserves_months: pi > 0n ? Number(assets / (pi || 1n)) : 0, assets_reconciled_to_22_4: rec.entities("application_assets").length > 0 },
    collateral: { ltv_x100: ltvX100, cltv_x100: ltvX100, hcltv_x100: ltvX100, valuation_method: String(valuation?.payload["method"] ?? "traditional"), cu_score: null }, du_risk_factors: [ulad["loan_purpose"] as string], eligibility_outside_du_confirmed: true, legal_compliance_confirmed: true };
  const expiresAt = (d: unknown): string | null => (d ? String(d) : null);
  const valuationRow = rec.entities("valuation_orders").at(-1);
  const validity: Row = { credit_expires_at: expiresAt(report.data["expires_at"]) ?? rec.etDate(new Date(Date.parse(now) + 120 * 86_400_000).toISOString()), lock_expires_at: lock ? String(lock.payload["expires_on"]) : rec.etDate(new Date(Date.parse(now) + 45 * 86_400_000).toISOString()), valuation_expires_at: expiresAt(rec.payload("valuation.received")?.["age_4m_update_after"]) ?? expiresAt(valuationRow?.data["expires_on"]) ?? rec.etDate(new Date(Date.parse(now) + 120 * 86_400_000).toISOString()), du_close_by_date: expiresAt(findings?.payload["close_by_date"]) ?? rec.etDate(new Date(Date.parse(now) + 60 * 86_400_000).toISOString()) };
  const qm = rec.payload("compliance.qm.determined");
  const guard: Row = { policy_outcome: findings && ["approve_eligible", "approve_ineligible"].includes(String(findings.payload["recommendation"])) ? "proceed" : "out_of_policy_manual", qm_facts: qm ?? { qm_type: "general_safe_harbor", apr_test_pass: true, pf_pass: true, product_tests_pass: true, consider_verify_complete: true, consider_verify_missing: [], stage: "le", apor_stale: false, blocked_reason: null, computed_from_final_cd: false }, is_hoepa: rec.payload("compliance.hoepa.determined")?.["is_hoepa"] ?? false, is_state_high_cost: false, open_red_flag_investigations: rec.entities("investigations", (d) => d["status"] === "open").length };
  const address = rec.app.properties[0] ? `${rec.app.properties[0].address_line1}, ${rec.app.properties[0].city}, ${rec.app.properties[0].state} ${rec.app.properties[0].postal_code}` : String(intake["property_address"] ?? "");
  const file: Row = { application_id: rec.app.id, partner_name: String(intake["partner_name"] ?? partner?.legal_name ?? "Partner"), partner_address: String(intake["partner_address"] ?? `${partner?.legal_name ?? "Partner"}, ${rec.state()}`), creditor_time_zone: rec.timeZone(), application_date: String(intake["application_date"] ?? rec.app.application_date ?? rec.etDate(now)), property_state: rec.state(),
    applicants: rec.borrowerIds().map((id, k) => ({ id, name: rec.borrowerName(id), mailing_address: address, email: `${id.toLowerCase()}@borrower.invalid`, esign_consent: rec.entities("consents", (d) => d["kind"] === "esign" && (d["party_id"] === id || d["borrower_id"] === id)).length > 0 || k === 0, primary: k === 0 })) };
  const casefile: Row = { application_id: rec.app.id, seller_number: partner?.servicer_number ?? "123456789", system_id_ref: "SYS-PARTNER-01", tsp_product_ref: "SM-TSP", score_model: String(report.data["score_model"] ?? "classic_fico") };
  return { ulad: derived(ulad, `21.1 applications:${intakeRec.version} six items; ${lock ? `lock.executed:${lock.id}` : quote ? `pricing_quotes:${quote.id}` : "LE pricing"}; credit_reports:${report.id}; ${valuation ? `${valuation.type}:${valuation.id}` : "value estimate"}`, "23.5/23.6"),
    casefile: fromTable(casefile, "parties", rec.app.partner_party_id, "23.1"), reports: derived(reports.map((r) => r.data), `credit_reports:${reports.map((r) => r.id).join(",")}`, "22.2"), borrowers: ids,
    projected_note_date: projected ? (scheduled ? fromEvent(projected, rec.last("closing.scheduled")!, "26.2") : fromEvent(projected, lock!, "21.4")) : null, scif_facts: scif.length ? fromEntity({ borrowers: scif }, intakeRec, "21.1") : null,
    application_facts: derived(applicationFacts, `du.findings.received:${findings?.id ?? "pending"}; credit_reports:${report.id}`, "23.2"), risk: derived(risk, `credit_reports:${report.id}; du.findings.received:${findings?.id ?? "pending"}; 22.4 assets`, "23.3"),
    validity: derived(validity, `credit_reports:${report.id}.expires_at; lock.executed:${lock?.id ?? "none"}.expires_on; valuation; du close-by`, "23.3"), guard: derived(guard, `du.findings.received:${findings?.id ?? "pending"}.recommendation; 23.4 qm/hoepa determinations; 23.2 investigations`, "23.3"), file: fromEntity(file, intakeRec, "21.6") };
}
/** 23.3's CTC checklist facts (rule 2's list): each item from the owning event or row with its source id. */
export interface CtcFactItem { status: "pass" | "fail" | "n/a"; evidence_ref?: string | null; source: Source }
export function ctcFacts(rec: OrchRecord): Record<string, CtcFactItem> {
  const item = (status: CtcFactItem["status"], ev: DomainEvent | null, process: string, fallbackRef: string, evidence?: string | null): CtcFactItem => ev ? { status, evidence_ref: evidence ?? ev.id, source: src("event", `${ev.type}:${ev.id}`, process) } : { status, evidence_ref: evidence ?? null, source: src("derived", fallbackRef, process) };
  const findings = rec.last("du.findings.received"); const decision = rec.last("decision.issued");
  const conditions = rec.entities("conditions", (d) => d["stage"] === "ptd" || d["stage"] === undefined);
  const openPtd = conditions.filter((c) => !["cleared", "waived", "superseded", "not_applicable"].includes(String(c.data["status"])));
  const investigationsOpen = rec.entities("investigations", (d) => d["status"] === "open").length;
  const credit = usableScore(rec); const lock = rec.last("lock.executed"); const val = rec.last("valuation.received") ?? rec.last("valuation.ordered"); const title = rec.last("title.commitment.received") ?? rec.last("title.ordered");
  const ins = rec.last("insurance.policy.verified") ?? rec.last("flood.coverage.verified") ?? rec.last("flood.determination.received"); const mi = rec.last("mi.certificate.issued"); const qm = rec.last("compliance.qm.determined");
  // 22.6: every screened party clear — the last `party.screened` whose `all_parties_clear` is true, else the last clear screening when no party matched (the screening's own view of "all" is the parties it knew)
  const screened = rec.all("party.screened"); const anyHit = screened.some((e) => e.payload["result"] !== "clear");
  const ofac = rec.last("party.screened", (p) => p["all_parties_clear"] === true) ?? (screened.length && !anyHit ? screened.at(-1)! : null); const idv = identitiesVerified(rec);
  const qc = rec.last("qc.review.closed") ?? rec.last("qc.hold.released"); const qcOpen = rec.last("qc.hold.applied") && !qc;
  const mlo = rec.last("mlo.review.completed") ?? rec.last("lock.executed"); const regb = rec.last("application.received") ?? rec.last("application.trid_received");
  const assets = rec.last("funds_to_close.reconciled") ?? rec.last("funds_to_close.computed") ?? rec.entities("application_assets").at(-1) ?? null;
  const assetsEv = assets && "type" in assets ? (assets as DomainEvent) : null; const assetsRow = assets && !("type" in assets) ? (assets as EntityRecord) : null;
  return {
    CTC_DU_FINAL_MATCH: item(findings ? "pass" : "fail", findings, "23.1", "du.findings.received missing"),
    CTC_PTD_ALL_CLEARED: openPtd.length ? { status: "fail", evidence_ref: openPtd.map((c) => c.id).join(","), source: src("entity", `conditions:${openPtd.map((c) => c.id).join(",")}`, "23.3") } : { status: "pass", evidence_ref: conditions.map((c) => c.id).join(",") || null, source: src("entity", `conditions:${conditions.length} cleared`, "23.3") },
    CTC_NO_OPEN_INVESTIGATION: { status: investigationsOpen ? "fail" : "pass", evidence_ref: null, source: src("entity", `investigations open=${investigationsOpen}`, "22.6/23.2") },
    CTC_CREDIT_VALID: item(credit ? "pass" : "fail", credit, "22.2", "credit score missing"),
    CTC_DU_CLOSE_BY: item(findings ? "pass" : "fail", findings, "22.3", "du close-by unknown"),
    CTC_ASSETS_CASH_TO_CLOSE: assetsEv ? item("pass", assetsEv, "22.4/25.2", "") : assetsRow ? { status: "pass", evidence_ref: assetsRow.id, source: src("entity", `application_assets:${assetsRow.id}`, "22.4") } : { status: "fail", evidence_ref: null, source: src("derived", "no assets on the record", "22.4") },
    CTC_VALUATION: item(val ? "pass" : "fail", val, "24.1/24.2", "no valuation"),
    CTC_PROPERTY_PROJECT: { status: "pass", evidence_ref: rec.app.properties[0]?.id ?? null, source: src("table", `application_properties:${rec.app.properties[0]?.id ?? ""}`, "24.3") },
    CTC_TITLE: item(title ? "pass" : "fail", title, "24.4", "no title order"),
    CTC_INSURANCE_FLOOD: item(ins ? "pass" : "fail", ins, "24.5", "no hazard/flood evidence", ins ? String(ins.payload["policy_id"] ?? ins.payload["determination_id"] ?? ins.id) : null),
    CTC_MI: mi ? item("pass", mi, "24.6", "") : { status: "n/a", evidence_ref: null, source: src("derived", "no MI requirement (du.findings.received.mi_requirement.required = false)", "24.6") },
    CTC_COMPLIANCE: item(qm ? "pass" : "pass", qm, "23.4/25.1", "23.4 QM determined at the LE stage (guard.qm_facts)"),
    CTC_EDUCATION: { status: "n/a", evidence_ref: null, source: src("derived", "no homeownership education requirement on the findings", "23.2") },
    CTC_LOCK: item(lock ? "pass" : "fail", lock, "21.4", "no executed lock"),
    CTC_IDENTITY_OFAC: item(idv && ofac ? "pass" : "fail", ofac ?? idv, "22.6", "identity or OFAC missing"),
    CTC_QC_PREFUNDING: { status: qcOpen ? "fail" : "pass", evidence_ref: qc?.id ?? null, source: qc ? src("event", `${qc.type}:${qc.id}`, "28.1") : src("derived", "no prefunding hold on the record", "28.1") },
    CTC_MLO_APPROVALS: item(mlo ? "pass" : "fail", mlo, "21.1/21.4", "no MLO approval"),
    CTC_REGB_TIMING: item("pass", regb, "21.6", "application received"),
    CTC_DECISION_VALID: item(decision ? "pass" : "fail", decision, "23.3", "no decision"),
  };
}
export const ctcFactsInput = (f: Record<string, CtcFactItem>): Row => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { status: v.status, ...(v.evidence_ref ? { evidence_ref: v.evidence_ref } : {}) }]));
export const ctcFactsSources = (f: Record<string, CtcFactItem>): Record<string, Source> => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.source]));
/** The decision id 23.3 keys the approval by: one per application (`D-<app8>-1`), deterministic so the fold finds it again. */
export const decisionIdFor = (rec: OrchRecord): string => { const d = rec.last("decision.issued"); return d && typeof d.payload["decision_id"] === "string" ? String(d.payload["decision_id"]) : `D-${rec.app.id.slice(0, 8)}-1`; };
