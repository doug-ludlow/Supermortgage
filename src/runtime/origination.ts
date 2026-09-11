/**
 * Funding an application in the hosted runtime — the 30.2 hand-off, end to end, in ONE transaction:
 *
 *   fundApplication(rt, applicationId, snapshot, funded, actor)
 *     the `applications` aggregate (0057) → OriginationBoardingService (src/domain/orig-boarding/ops-30-2.ts) run inside
 *     PgUnitOfWork.run with scope { applicationId, loanId } → the servicing rows the hand-off creates (loans with
 *     origination_application_id and fnma_loan_number NULL, borrowers + loan_borrowers linked from application_borrowers,
 *     the property linked from application_properties, loan_terms v1, the pre-purchase T&I and per-loan funding-clearing
 *     custodial accounts, boarding_validations keyed by application + loan), the application ↔ loan link
 *     (applications.loan_id / loans.origination_application_id), every 30.2 event (each carrying BOTH ids), the 1.6-style
 *     opening ledger set, every timer the events armed, entity versions and escalations — or nothing.
 *
 *   Idempotent by application id (30.2-T13): an application that already has its loan is answered with the stored
 *   summary, `duplicate: true`, and one `loan.funded.duplicate_ignored` receipt on the log; no second loans row, ledger
 *   set or letter. A refusal (rescission not expired, an open hard OB-* failure) throws BoardingRefused and persists
 *   nothing — the command bus's "one transaction or nothing" rule; the source record is corrected and funding re-run.
 *
 *   demoSnapshot(application, overrides?)
 *     the 30.2 refinance fixture ($560,000 at 6.125% / 360, first payment 2027-01-01, consummation Fri 2026-11-06,
 *     disbursement Thu 2026-11-12, escrow $687.50 / deposit $2,062.50, prepaid interest 19 × $93.97) built from a real
 *     ApplicationRecord so the runtime can fund a synthetic application end to end.
 *
 * Seam notes (what the persistence layer had to bridge):
 *   - 30.2 names the per-loan funding clearing account `orig-funding-clearing:<loanId>`; `ledger_lines.custodial_account_id`
 *     is a uuid FK to `custodial_accounts`, so a `custodial_accounts{kind=origination_funding_clearing}` row is created per
 *     loan and the service's ledger is wrapped to re-key that one account (`ledgerFor`). The pre-purchase T&I account
 *     (30.1 prerequisite) is one `custodial_accounts{kind=ti_prepurchase}` row per partner.
 *   - `OrigExternal.mers` is synchronous; the fake MERS port is async. The snapshot's `min.registration` (26.4's status at
 *     funding) answers the lookup here, the way 30.2's own harness does.
 *   - `OrigExternal.onPlatform` reads the live `loans` table before the transaction (HF-017 semantics), so the service's
 *     servicing-loan-number sequence skips numbers already allocated.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "../infra/db/client.ts";
import { toJson } from "../infra/db/client.ts";
import type { ApplicationRecord } from "../infra/db/applications.ts";
import type { EntityScope } from "../infra/db/entities.ts";
import { EntityStore } from "../app/tools.ts";
import { EscalationService } from "../app/escalations.ts";
import { NoticeService } from "../notices/service.ts";
import type { Actor } from "../kernel/events/index.ts";
import type { AccountRef, EntrySet, EntrySetInput, Ledger, Line } from "../kernel/ledger/ledger.ts";
import type { TimerInstance } from "../kernel/timers/engine.ts";
import { plainDate as D } from "../kernel/calendar/date.ts";
import type { Cents } from "../kernel/money/cents.ts";
import { makeMin } from "../domain/boarding/min.ts";
import { PARTNER_ORG } from "../domain/boarding/fixtures.ts";
import { boardFundedApplication, noteTermsHash, ORIGINATION_CONSENT_CLASSES, SERVICING_CONSENT_CLASSES, type LetterRecord, type LoanFundedPayload, type OrigExternal, type OrigValidation, type OriginationSnapshot } from "../domain/orig-boarding/ops-30-2.ts";
import { DEFAULT_LICENSED_STATES } from "./transfers.ts";
import type { Runtime } from "./app.ts";

export class ApplicationNotFound extends Error { constructor(id: string) { super(`no application ${id}`); this.name = "ApplicationNotFound"; } }
/** Boarding refused by 30.2 (rescission not expired — OB-018; an open hard OB-* failure): nothing is persisted. */
export class BoardingRefused extends Error {
  readonly code: string; readonly applicationId: string; readonly validations: readonly OrigValidation[];
  constructor(applicationId: string, code: string, reason: string, validations: readonly OrigValidation[]) { super(reason); this.name = "BoardingRefused"; this.code = code; this.applicationId = applicationId; this.validations = validations; }
}

export interface FundApplicationResult {
  readonly application_id: string;
  readonly loan_id: string;
  readonly servicing_loan_number: string;
  /** 30.2's boarding status after the hand-off (`boarded` | `boarded_with_warnings`), `loans.status` is `active`. */
  readonly status: string;
  readonly validations: readonly OrigValidation[];
  readonly opening_entry_set_id: string | null;
  readonly timers: readonly TimerInstance[];
  readonly letters: readonly LetterRecord[];
  readonly duplicate: boolean;
  readonly events: number;
}

const BOARDING_ACTOR: Actor = { kind: "agent", id: "boarding" };
const ORIG_CLEARING_PREFIX = "orig-funding-clearing:";
const ENTITY_KIND = "origination_boardings";

/** The service's ledger, with 30.2's synthetic per-loan clearing account re-keyed to the `custodial_accounts` row the runtime created for it. */
function ledgerFor(inner: Ledger, clearingAccountId: string): Ledger {
  const remap = (a: AccountRef): AccountRef => (a.scope === "custodial" && a.custodialAccountId.startsWith(ORIG_CLEARING_PREFIX) ? { ...a, custodialAccountId: clearingAccountId } : a);
  return {
    post: (input: EntrySetInput, postedAt?: string): EntrySet => inner.post({ ...input, lines: input.lines.map((l) => ({ ...l, account: remap(l.account) })) }, postedAt),
    reverse: (setId, effectiveDate, reason, postedAt) => inner.reverse(setId, effectiveDate, reason, postedAt),
    balance: (a, asOf) => inner.balance(remap(a), asOf),
    sets: () => inner.sets(),
    linesFor: (a): readonly Line[] => inner.linesFor(remap(a)),
  };
}

const pctToScaled = (pct: string, scale: number): number => Math.round(Number(pct) * scale);
const tinLast4 = (tin: string | null): string | null => (tin ? tin.replace(/\D/g, "").slice(-4) || null : null);

export async function fundApplication(rt: Runtime, applicationId: string, snapshot: OriginationSnapshot, funded: LoanFundedPayload, actor: Actor): Promise<FundApplicationResult> {
  const app = await rt.applications.get(applicationId);
  if (!app) throw new ApplicationNotFound(applicationId);
  if (snapshot.application_id !== applicationId || funded.application_id !== applicationId) throw new RangeError("snapshot.application_id and funded.application_id must be the application being funded");

  // ---- idempotent by application id (T13): the loan already exists → receipt on the log, the stored summary back, nothing else written
  if (app.loan_id) {
    const stored = await rt.entities.current(ENTITY_KIND, applicationId);
    const loanId = app.loan_id;
    const r = await rt.uow.run({ applicationId, loanId }, (ctx) => ctx.events.append({ type: "loan.funded.duplicate_ignored", applicationId, loanId, actor: BOARDING_ACTOR,
      payload: { application_id: applicationId, loan_id: loanId, funded_event_id: (stored?.data["funded_event_id"] as string | null | undefined) ?? null, receipt: "duplicate", by: `${actor.kind}:${actor.id}` } }), { clock: rt.clock });
    const base = (stored?.data ?? {}) as Partial<FundApplicationResult>;
    return { application_id: applicationId, loan_id: loanId, servicing_loan_number: base.servicing_loan_number ?? "", status: base.status ?? "boarded", validations: base.validations ?? [], opening_entry_set_id: base.opening_entry_set_id ?? null, timers: [], letters: base.letters ?? [], duplicate: true, events: r.events.length };
  }

  // ---- external positions read before the transaction: what is already on the platform (HF-017), the licenses, MERS as 26.4 left it
  const numbers = new Set((await rt.db.query<{ n: string }>(`SELECT servicer_loan_number AS n FROM loans WHERE servicer_loan_number ~ '^[0-9]{10}$'`)).map((x) => x.n));
  const mins = new Set(snapshot.min.value ? (await rt.db.query<{ m: string }>(`SELECT min AS m FROM loans WHERE min = $1`, [snapshot.min.value])).map((x) => x.m) : []);
  const licensed = new Set(DEFAULT_LICENSED_STATES);
  const ext: OrigExternal = {
    licensed: (s) => licensed.has(s),
    onPlatform: (kind, value) => (kind === "servicing_loan_number" ? numbers.has(value) : mins.has(value)),
    mers: (min) => (snapshot.min.value === min && snapshot.min.registration === "active" ? { status: "Active", org_id: snapshot.partner_mers_org_id } : snapshot.min.value === min && snapshot.min.registration === "pending" ? { status: "Pending", org_id: snapshot.partner_mers_org_id } : undefined),
  };
  const partnerPartyId = app.partner_party_id;
  const existingTi = await rt.db.query<{ id: string }>(`SELECT id FROM custodial_accounts WHERE partner_party_id = $1 AND kind = 'ti_prepurchase' ORDER BY created_at LIMIT 1`, [partnerPartyId]);
  const tiPrepurchaseId = existingTi[0]?.id ?? randomUUID();
  const tiIsNew = !existingTi[0];
  const clearingId = randomUUID();
  const loanId = randomUUID();
  const scope: EntityScope = { loanId, applicationId };
  const store = new EntityStore();
  store.seed(await rt.entities.load(scope));
  const mark = store.versionCount();

  let escalations: EscalationService | undefined;
  let outcome: Awaited<ReturnType<typeof boardFundedApplication>> | undefined;
  const r = await rt.uow.run(scope, async (ctx) => {
    escalations = new EscalationService(ctx.events, ctx.clock);
    const notices = rt.ports.printMail && rt.ports.edelivery ? new NoticeService({ registry: rt.noticeRegistry, events: ctx.events, clock: ctx.clock, printMail: rt.ports.printMail, edelivery: rt.ports.edelivery }) : undefined;
    const res = await boardFundedApplication({ events: ctx.events, ledger: ledgerFor(ctx.ledger, clearingId), clock: ctx.clock, ext, timers: ctx.timers, escalations, ...(notices ? { notices } : {}), prepurchaseTiAccountId: tiPrepurchaseId, loanIdFor: () => loanId },
      snapshot, funded);
    if (res.refusal !== null) {
      const hard = res.validations.filter((v) => v.severity === "hard" && v.result === "fail" && !v.resolved).map((v) => v.code);
      throw new BoardingRefused(applicationId, hard.length ? "BOARDING_HARD_FAILURE" : "RESCISSION_NOT_EXPIRED", res.refusal, res.validations);
    }
    outcome = res;
    const rec = res.service.record(applicationId);
    const summary: Record<string, unknown> = { application_id: applicationId, loan_id: loanId, servicing_loan_number: res.servicing_loan_number, status: res.status, validations: res.validations, opening_entry_set_id: res.ledger_set?.id ?? null, letters: res.letters, funded_event_id: rec.funded_event_id, boarded_at: rec.boarded_at ?? null, snapshot_hash: rec.mapped.snapshot_hash };
    store.put(ENTITY_KIND, applicationId, summary, actor, ctx.clock.now());
    return res;
  }, {
    clock: rt.clock,
    // the rows the events reference, written first in the same transaction
    before: async (q) => { await insertServicingRows(q, app, outcome!, { loanId, partnerPartyId, tiPrepurchaseId, tiIsNew, clearingId, funded, snapshot }); await rt.applications.linkLoan(applicationId, loanId, q); await rt.applications.setStatus(applicationId, "funded", q); },
    commit: async (q) => {
      await rt.entities.save(store.versionsSince(mark), scope, q);
      for (const e of escalations?.list() ?? []) await rt.escalationRepo.save(e, q);
    },
  });
  const res = r.result;
  return { application_id: applicationId, loan_id: loanId, servicing_loan_number: res.servicing_loan_number, status: res.status, validations: res.validations, opening_entry_set_id: res.ledger_set?.id ?? null, timers: r.timers, letters: res.letters, duplicate: false, events: r.events.length };
}

interface RowInputs { readonly loanId: string; readonly partnerPartyId: string; readonly tiPrepurchaseId: string; readonly tiIsNew: boolean; readonly clearingId: string; readonly funded: LoanFundedPayload; readonly snapshot: OriginationSnapshot; }
/** loans, borrowers + loan_borrowers (application_borrowers.borrower_id set), the property (application_properties.property_id set), loan_terms v1, the custodial accounts, boarding_validations. */
async function insertServicingRows(q: Queryable, app: ApplicationRecord, res: Awaited<ReturnType<typeof boardFundedApplication>>, i: RowInputs): Promise<void> {
  const rec = res.service.record(app.id); const m = rec.mapped; const s = i.snapshot;
  if (i.tiIsNew) await q.query(`INSERT INTO custodial_accounts (id, partner_party_id, kind, remittance_type) VALUES ($1, $2, 'ti_prepurchase', 'A/A')`, [i.tiPrepurchaseId, i.partnerPartyId]);
  await q.query(`INSERT INTO custodial_accounts (id, partner_party_id, kind, remittance_type) VALUES ($1, $2, 'origination_funding_clearing', 'A/A')`, [i.clearingId, i.partnerPartyId]);
  // the property: the application's subject property becomes the servicing row (linked back), else one from the snapshot
  const subject = app.properties[0];
  const prop = await q.query<{ id: string }>(`INSERT INTO properties (address_line1, city, state, postal_code, county, tax_parcel_id, tax_parcel_verified, property_type, occupancy, units, flood_zone) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [s.property.address_line1 ?? subject?.address_line1 ?? "(unknown)", s.property.city ?? subject?.city ?? "(unknown)", s.property.state ?? subject?.state ?? "XX", s.property.postal_code ?? subject?.postal_code ?? "00000", s.property.county, s.property.apn, s.tax_service_parcel_verified, s.property.property_type, s.property.occupancy, s.property.units, s.property.flood_zone]);
  const propertyId = prop[0]!.id;
  if (subject) await q.query(`UPDATE application_properties SET property_id = $2 WHERE id = $1`, [subject.id, propertyId]);
  const boarded = rec.boarded_at ?? null;
  await q.query(`INSERT INTO loans (id, fnma_loan_number, servicer_loan_number, min, mers_eligible, partner_party_id, property_id, status, instrument_date, origination_date, original_upb_cents, original_term_months, first_payment_date, maturity_date, emortgage, boarded_at, default_status_at_boarding, fdcpa_debt_collector_flag, origination_application_id)
    VALUES ($1, NULL, $2, $3, true, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, false, false, $15)`,
    [i.loanId, m.loans.servicing_loan_number, m.loans.min, i.partnerPartyId, propertyId, boarded ? "active" : "staged", m.loans.note_date, m.loans.consummation_date, m.loans.original_loan_amount_cents, m.loan_terms.original_term_months, m.loans.first_payment_date, m.loans.maturity_date, s.custody.kind === "enote", boarded, app.id]);
  // borrowers: one servicing party per application borrower, linked both ways; the snapshot's party_id is the application_borrowers.id when the snapshot was built from the record
  const byParty = new Map(app.borrowers.map((b) => [b.id, b]));
  for (const [k, b] of m.borrowers.entries()) {
    const src = byParty.get(b.party_id) ?? app.borrowers[k];
    const row = await q.query<{ id: string }>(`INSERT INTO borrowers (legal_name, tin_last4, date_of_birth, preferred_language) VALUES ($1, $2, $3, $4) RETURNING id`, [b.legal_name, tinLast4(b.tin), b.dob, b.language_preference]);
    await q.query(`INSERT INTO loan_borrowers (loan_id, borrower_id, role, is_primary) VALUES ($1, $2, $3, $4)`, [i.loanId, row[0]!.id, b.role === "borrower" ? "borrower" : "coborrower", k === 0]);
    if (src) await q.query(`UPDATE application_borrowers SET borrower_id = $2 WHERE id = $1`, [src.id, row[0]!.id]);
  }
  if (boarded) {
    const t = m.loan_terms; const a = t.arm ?? {};
    await q.query(`INSERT INTO loan_terms (loan_id, effective_from, source, source_event_id, amortization, note_rate_bps, pi_cents, escrow_payment_cents, escrowed, interest_method, remittance_type, late_charge_pct_bps, late_charge_grace_days, maturity_date, remaining_term_months, arm_index, arm_margin_bps, arm_initial_cap_bps, arm_periodic_cap_bps, arm_lifetime_cap_bps, arm_lookback_days)
      VALUES ($1, $2, 'boarding', $3, $4, $5, $6, $7, $8, '30_360', 'A/A', $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [i.loanId, i.funded.disbursement_date, rec.funded_event_id, t.amortization_type, pctToScaled(t.note_rate, 10_000), t.pi_cents, t.escrow_payment_cents + t.mi_premium_cents, s.escrow_analysis !== null, pctToScaled(t.late_charge_pct, 1000), t.late_charge_grace_days, m.loans.maturity_date, t.original_term_months,
        a.index ?? null, a.margin_bps ?? null, a.initial_cap_bps ?? null, a.periodic_cap_bps ?? null, a.lifetime_cap_bps ?? null, a.lookback_days ?? null]);
  }
  for (const v of res.validations) await q.query(`INSERT INTO boarding_validations (batch_loan_id, application_id, run_id, rule_code, severity, result, expected, actual, message, rule_set_version) VALUES (NULL, $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
    [app.id, v.run_id, v.code, v.severity, v.result, v.expected === undefined ? null : toJson(v.expected), v.actual === undefined ? null : toJson(v.actual), v.message ?? null, v.rule_set_version]);
}

// ───────────────────────────── the demo snapshot (30.2 refinance fixture from a real application) ─────────────────────────────
export const DEMO_NOTE = { amount_cents: 56_000_000n as Cents, note_rate_pct: "6.125", term_months: 360, first_payment_date: D("2027-01-01"), maturity_date: D("2056-12-01"), late_charge_pct: "5.00", late_charge_grace_days: 15 };
export const DEMO_FUNDED: Omit<LoanFundedPayload, "application_id"> = { funded_at: "2026-11-12T18:40:00.000Z", funding_date: D("2026-11-12"), disbursement_date: D("2026-11-12"), wire_id: "IMAD-20261112-001", funded_amount_cents: 56_000_000n, per_diem_cents: 9_397n, prepaid_interest_cents: 178_543n, interest_credit: false, rescission_expires_at: "2026-11-11T06:59:59.000Z" };

/** A MIN unique to the application (loans.min is unique on the platform): the partner org + a 10-digit sequence hashed from the application id. */
export function demoMin(applicationId: string): string {
  const h = createHash("sha256").update(`supermortgage:demo-min:${applicationId}`).digest("hex");
  return makeMin(PARTNER_ORG, String(parseInt(h.slice(0, 12), 16) % 10_000_000_000));
}

export type DemoOverrides = Partial<OriginationSnapshot> & { readonly partner_name?: string };
/**
 * The 30.2 refinance fixture built from the application's own row: its id, partner, borrowers (party_id = application_borrowers.id)
 * and subject property, with the worked example's note / CD / escrow / consents / documents. `overrides` replace whole top-level
 * fields (the 30.2 correction rule: a snapshot is replaced, never edited).
 */
export function demoSnapshot(app: ApplicationRecord, overrides: DemoOverrides = {}): OriginationSnapshot {
  const { partner_name, ...rest } = overrides;
  const prop = app.properties[0];
  const address = prop ? `${prop.address_line1}, ${prop.city}, ${prop.state} ${prop.postal_code}` : "100 N Central Ave, Phoenix, AZ 85004";
  const borrowers: OriginationSnapshot["borrowers"] = app.borrowers.map((b, k) => ({ party_id: b.id, legal_name: b.legal_name, tin: k === 0 ? "123456789" : "987654321", dob: k === 0 ? D("1985-04-02") : D("1983-09-14"), phone: k === 0 ? "(602) 555-0101" : "(602) 555-0102", email: `${b.legal_name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`, mailing_address: address, language_preference: "en", acp_enrolled: false, role: k === 0 ? "borrower" : "coborrower",
    // 21.1 applicant_demographics: borrower A self-reported; every other borrower "information not provided" — never inferred
    demographics: k === 0 ? { race: ["white"], ethnicity: ["not_hispanic_or_latino"], sex: "female", age: 41, preferred_language: "en", collected_via: "self_reported" } : { race: "not_provided", ethnicity: "not_provided", sex: "not_provided", age: 43, preferred_language: "en", collected_via: "not_provided" } }));
  const a = borrowers[0]; const b = borrowers[1];
  const purchase = app.transaction_type === "purchase";
  const note: OriginationSnapshot["note"] = { document_id: "DOC-NOTE", data_hash: "note-render-hash", note_date: D("2026-11-06"), ...DEMO_NOTE, amortization: "fixed", arm: null, buydown_schedule: null, partner_nmlsr_id: "123456", mlo_nmlsr_id: app.mlo_nmlsr_id ?? "654321", security_instrument_version: "uniform_2021" };
  const V20 = [...ORIGINATION_CONSENT_CLASSES, ...SERVICING_CONSENT_CLASSES];
  return {
    application_id: app.id, partner_id: app.partner_party_id, partner_name: partner_name ?? "Partner Bank", partner_mers_org_id: PARTNER_ORG,
    loan_purpose: purchase ? "purchase" : "refinance", rescindable: !purchase, rescission_expires_at: purchase ? null : "2026-11-11T06:59:59.000Z",   // Tue Nov 10, 2026 23:59:59 MST
    note, closing: { consummation_date: D("2026-11-06"), note_terms_hash: noteTermsHash(DEMO_NOTE), security_instrument_document_id: "DOC-DOT" },
    final_cd: { document_id: "DOC-CD", pi_cents: 340_262n, monthly_escrow_cents: 68_750n, initial_escrow_deposit_cents: 206_250n, prepaid_interest_cents: 178_543n, prepaid_interest_days: 19, compliance_tests_passed: true },
    // 30.3 initial analysis: base $687.50 + cushion $1,375.00 = deposit $2,062.50; taxes $6,400/yr, hazard $1,850/yr
    escrow_analysis: { source: "origination", type: "initial", required_start_balance_cents: 68_750n, cushion_cents: 137_500n, monthly_escrow_cents: 68_750n, lines: [{ line_type: "county_tax", annual_amount_cents: 640_000n, monthly_cents: 53_333n }, { line_type: "hazard", annual_amount_cents: 185_000n, monthly_cents: 15_417n }], status: "active" },
    hpml: false, qm_type: "general_qm", ltv_pct: "70.00", mi: null,
    hazard: { verified: true, mortgagee_clause_partner_isaoa_co_sm: true, expires_on: D("2027-11-12") }, flood: { determination_present: true, lol_purchased: true, lol_contract_linked: true, sfha: false, policy_verified: false },
    min: { value: demoMin(app.id), registration: "active" }, custody: { kind: "paper", custodian: "Custodian Bank NA", status: "received" }, warehouse_advance_id: `WA-${app.id.slice(0, 8)}`,
    borrowers,
    consents: [
      ...(a ? [{ id: `C-${a.party_id}-ESIGN`, party_id: a.party_id, kind: "esign" as const, disclosure_version: "2.0", servicing_group_elected: true, demonstration_passed: true, demonstration_channel: "portal" as const, captured_via: "portal" as const, captured_at: "2026-10-05T16:00:00.000Z" },
        { id: `C-${a.party_id}-TCPA`, party_id: a.party_id, kind: "tcpa_voice" as const, captured_via: "portal" as const, captured_at: "2026-10-05T16:05:00.000Z" }] : []),
      ...(b ? [{ id: `C-${b.party_id}-ESIGN`, party_id: b.party_id, kind: "esign" as const, disclosure_version: "1.4", servicing_group_elected: false, demonstration_passed: true, demonstration_channel: "portal" as const, captured_via: "portal" as const, captured_at: "2026-10-05T16:10:00.000Z" }] : []),
    ],
    disclosure_versions: { "2.0": { categories: V20, providers: [partner_name ?? "Partner Bank", "its servicer Supermortgage"], delivery_form: "portal_pdf" }, "1.4": { categories: [...ORIGINATION_CONSENT_CLASSES], providers: [partner_name ?? "Partner Bank"], delivery_form: "portal_pdf" } },
    property: { address_line1: prop?.address_line1 ?? "100 N Central Ave", city: prop?.city ?? "Phoenix", state: prop?.state ?? "AZ", postal_code: prop?.postal_code ?? "85004", county: "Maricopa", apn: "112-23-045", property_type: "sfr", units: 1, occupancy: app.occupancy === "primary" ? "primary" : app.occupancy, flood_zone: "X", sfha: false, appraised_value_cents: 80_000_000n, original_value_cents: 80_000_000n },
    documents: [{ id: "DOC-NOTE", kind: "note", sha256: "a".repeat(64), custody: "custodian" }, { id: "DOC-DOT", kind: "security_instrument", sha256: "b".repeat(64), custody: "platform" }, { id: "DOC-CD", kind: "closing_disclosure_final", sha256: "c".repeat(64), custody: "platform" }, { id: "DOC-LE", kind: "loan_estimate", sha256: "d".repeat(64), custody: "platform" }, { id: "DOC-APPR", kind: "appraisal", sha256: "e".repeat(64), custody: "platform" }, { id: "DOC-ESIGN", kind: "esign_consent", sha256: "f".repeat(64), custody: "platform" }, { id: "DOC-IES", kind: "escrow_initial_statement", sha256: "1".repeat(64), custody: "platform" }, { id: "DOC-SFHDF", kind: "sfhdf", sha256: "2".repeat(64), custody: "platform" }],
    trailing: { recorded_security_instrument_received: false, final_title_policy_received: false }, tax_service_parcel_verified: false, initial_escrow_statement_delivered: true, ach_autopay_elected: false,
    ...rest,
  };
}

/** 26.3's `loan.funded` payload for the demo fixture, with any overrides (dates/amounts as the caller states them). */
export function demoFunded(applicationId: string, overrides: Partial<LoanFundedPayload> = {}): LoanFundedPayload {
  return { application_id: applicationId, ...DEMO_FUNDED, ...overrides, ...(overrides.application_id ? { application_id: overrides.application_id } : {}) };
}

