/**
 * The servicing-side scheduled passes the hosted runtime runs for a boarded loan (the "daily sweeps" of 2.1, 2.3 and 2.7
 * and the 7.1 statement / 1098 runs), each executed through the owning process's own bus tool or service inside a unit
 * of work — the same path the borrower flows of section 32 read from (docs/ux/BACKEND-DELTAS.md, 32.8):
 *
 *   loanCashState(rt, loanId, asOf)     the 2.x LoanCashState of a boarded loan, built from `loans`, `loan_terms` (+ the 3.6
 *                                        loan_terms version in the entity store), the ledger balances, the `payments` rows and
 *                                        the `fees` rows — never a hand-fed figure.
 *   servicingDailySweep(rt, nowIso)     for every boarded loan: 2.1 `payments.read/write{op=post}` for each received payment
 *                                        (the allocation engine; a partial opens the 2.2 suspense item), 2.7 `fees.assess{op=daily_run}`
 *                                        on a due date or the day after a grace end (`installment.due_date_reached` → the
 *                                        NOTE_6A grace gate; `fee.assessed{late_charge}`), and 2.3 `autodraft.read/write
 *                                        {op=amount_change_check}` when the next draft's amount differs from the last debit
 *                                        (Reg E §1005.10(d)(1): the escrow statement that stated the exact amount and date
 *                                        satisfies it; otherwise `AUTODRAFT-AMOUNT-CHANGE-v1` ≥ 10 days before the draft).
 *   sendPeriodicStatement(rt, loanId, …) 7.1's cycle run (StatementCycleService over the runtime's NoticeService and the FAKE
 *                                        print/mail and e-delivery ports): the availability e-mail (`NTC_REGZ_41_STMT_AVAIL_EMAIL`)
 *                                        under an active `periodic_statements` consent, then the statement — a hard bounce on
 *                                        the e-mail marks the consent `suspect` (7.4 rule 8: consents row + `consent.esign.suspect`),
 *                                        so the statement mails the same day (`statement.bounced`, `statement.fallback_mailed`,
 *                                        `statement.sent{mailed_at}` after the vendor's production run).
 *   furnishForm1098(rt, loanId, …)      7.1-A / 7.4 rule 11: `tax_form.1098.furnish_requested` through IRS_1098_ECONSENT_GATE
 *                                        (electronic only under a separate active `irs_estatement` consent), then `NTC_IRS_1098`
 *                                        through the registry — paper without the consent (`tax_form.1098.furnished{channel=paper}`).
 *
 * Money is bigint cents; dates are PlainDate; every figure comes from the tables, the ledger or the owning engine.
 */
import type { Queryable } from "../infra/db/client.ts";
import { EntityStore } from "../app/tools.ts";
import { NoticeService } from "../notices/service.ts";
import type { Recipient } from "../notices/channel.ts";
import type { Actor } from "../kernel/events/index.ts";
import { plainDate as D, addDays, addMonths, type PlainDate } from "../kernel/calendar/date.ts";
import { divRound } from "../kernel/money/decimal.ts";
import type { Cents } from "../kernel/money/cents.ts";
import { graceEndFor, lateFeeDisclosure } from "../domain/cashiering/latecharges.ts";
import type { Fee, InstallmentProjection, LoanCashState } from "../domain/cashiering/types.ts";
import type { Consent, ConsentStatus } from "../domain/notices/esign.ts";
import { StatementCycleService } from "../domain/notices/ops-7-1.ts";
import { DISCLOSURES_AGENT as STATEMENT_AGENT } from "../notices/service.ts";   // the `disclosures` agent constant lives in src/notices/service.ts (ops-7-1.ts exports none) — import path corrected by the 32.5 build to unblock the shared journey fixture
import { requestForm1098Furnish, recordBounceSuspect } from "../domain/notices/ops-7-4.ts";
import type { Runtime } from "./app.ts";

export const CASHIERING_AGENT: Actor = { kind: "agent", id: "cashiering" };
/** FAKE servicer contact block every servicing notice carries (the authored samples' values; no real address). */
export const SERVICER_CONTACT = { servicer_name: "Supermortgage LLC", servicer_tin: "12-3456789", servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001", exclusive_address: "PO Box 2, Testville TX 75001", remittance_address: "Supermortgage, PO Box 7, Testville TX 75001", portal_url: "https://portal.example.com/statements", counselor_url: "consumerfinance.gov/find-a-housing-counselor", hud_phone: "(800) 569-4287" } as const;
type Row = Record<string, unknown>;
const c = (v: unknown): Cents => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v)));
const s = (v: Cents): string => v.toString();

export interface LoanRow { readonly id: string; readonly instrument_date: PlainDate; readonly original_upb_cents: Cents; readonly first_payment_date: PlainDate; readonly boarded_at: string | null; readonly servicer_loan_number: string; readonly partner_party_id: string; readonly property_id: string; readonly status: string; readonly origination_application_id: string | null; }
export interface LoanTerms { readonly pi_cents: Cents; readonly escrow_payment_cents: Cents; readonly note_rate_bps: number; readonly late_charge_pct: string; readonly late_charge_grace_days: number; readonly late_charge_max_cents: Cents | null; readonly escrowed: boolean; readonly escrow_version: { escrow_payment_cents: Cents; effective_from: PlainDate; step_down_on: PlainDate | null; step_down_to_cents: Cents | null } | null; }
export interface LoanFacts { readonly loan: LoanRow; readonly terms: LoanTerms; readonly custodial: { clearing: string; pi: string; ti: string } | null; readonly state: LoanCashState; readonly store: EntityStore; readonly balances: { principal: Cents; escrow: Cents; suspense_unapplied: Cents; late_charges: Cents; interest_due: Cents }; readonly received_payments: Row[]; }

async function balances(db: Queryable, loanId: string): Promise<LoanFacts["balances"]> {
  const rows = await db.query<{ account: string; s: string }>(`SELECT account, sum(amount_cents)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 GROUP BY account`, [loanId]);
  const of = (a: string): Cents => c(rows.find((r) => r.account === a)?.s ?? "0");
  return { principal: of("principal"), escrow: -of("escrow"), suspense_unapplied: -of("suspense_unapplied"), late_charges: -of("late_charges"), interest_due: -of("interest_due") };
}
/** The escrow portion of the installment due on `due`: the 3.6 loan_terms version from its effective date (and the step-down after the plan) else the boarded terms. */
export function escrowPortionOn(terms: LoanTerms, due: PlainDate): Cents {
  const v = terms.escrow_version;
  if (v && due >= v.effective_from) { if (v.step_down_on && due >= v.step_down_on && v.step_down_to_cents !== null) return v.step_down_to_cents; return v.escrow_payment_cents; }
  return terms.escrow_payment_cents;
}
/** The 2.x LoanCashState of a boarded loan as of a date — every installment from the first payment date through the month after `asOf`, satisfied where a posted payment applied it. */
export async function loanCashState(rt: Runtime, loanId: string, asOf: PlainDate): Promise<LoanFacts> {
  const loanRow = (await rt.db.query<Row>(`SELECT id, instrument_date::text AS instrument_date, original_upb_cents::text AS original_upb_cents, first_payment_date::text AS first_payment_date, boarded_at, servicer_loan_number, partner_party_id, property_id, status::text AS status, origination_application_id FROM loans WHERE id = $1`, [loanId]))[0];
  if (!loanRow) throw new RangeError(`no loan ${loanId}`);
  const termsRow = (await rt.db.query<Row>(`SELECT pi_cents::text AS pi_cents, escrow_payment_cents::text AS escrow_payment_cents, note_rate_bps, late_charge_pct_bps, late_charge_grace_days, late_charge_max_cents::text AS late_charge_max_cents, escrowed FROM loan_terms WHERE loan_id = $1 ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [loanId]))[0];
  if (!termsRow) throw new RangeError(`no loan_terms for ${loanId}`);
  const store = new EntityStore(); store.seed(await rt.entities.load({ loanId }));
  const lt = store.get("loan_terms", loanId)?.data;
  const escrowVersion = lt && lt.escrow_payment_cents !== undefined && typeof lt.escrow_payment_effective_from === "string" ? { escrow_payment_cents: c(lt.escrow_payment_cents), effective_from: D(lt.escrow_payment_effective_from), step_down_on: typeof lt.escrow_step_down_on === "string" ? D(lt.escrow_step_down_on) : null, step_down_to_cents: lt.escrow_step_down_to_cents !== undefined ? c(lt.escrow_step_down_to_cents) : null } : null;
  const loan: LoanRow = { id: loanId, instrument_date: D(String(loanRow.instrument_date)), original_upb_cents: c(loanRow.original_upb_cents), first_payment_date: D(String(loanRow.first_payment_date)), boarded_at: (loanRow.boarded_at as string | null) ?? null, servicer_loan_number: String(loanRow.servicer_loan_number ?? ""), partner_party_id: String(loanRow.partner_party_id), property_id: String(loanRow.property_id), status: String(loanRow.status), origination_application_id: (loanRow.origination_application_id as string | null) ?? null };
  const bps = Number(termsRow.late_charge_pct_bps ?? 5000);
  const terms: LoanTerms = { pi_cents: c(termsRow.pi_cents), escrow_payment_cents: c(termsRow.escrow_payment_cents), note_rate_bps: Number(termsRow.note_rate_bps), late_charge_pct: String(bps / 1000), late_charge_grace_days: Number(termsRow.late_charge_grace_days ?? 15), late_charge_max_cents: termsRow.late_charge_max_cents === null || termsRow.late_charge_max_cents === undefined ? null : c(termsRow.late_charge_max_cents), escrowed: termsRow.escrowed === true, escrow_version: escrowVersion };
  const bal = await balances(rt.db, loanId);
  const cust = await rt.db.query<{ id: string; kind: string }>(`SELECT id, kind FROM custodial_accounts WHERE partner_party_id = $1 AND kind IN ('clearing', 'pi', 'ti') ORDER BY created_at`, [loan.partner_party_id]);
  const last = (kind: string): string | undefined => cust.filter((x) => x.kind === kind).at(-1)?.id;
  const custodial = last("clearing") && last("pi") && last("ti") ? { clearing: last("clearing")!, pi: last("pi")!, ti: last("ti")! } : null;
  const payments = store.list("payments", (d) => d.loan_id === loanId).map((r) => r.data);
  const satisfied = new Map<string, { payment_id: string; credited_as_of: PlainDate; received_on: PlainDate }>();
  for (const p of payments) if (p.status === "posted" && Array.isArray(p.installments)) for (const due of p.installments as string[]) satisfied.set(due, { payment_id: String(p.payment_id ?? ""), credited_as_of: D(String(p.credited_as_of ?? p.received_on)), received_on: D(String(p.received_on)) });
  const installments: InstallmentProjection[] = [];
  const horizon = addMonths(asOf, 1);
  for (let due = loan.first_payment_date, k = 0; due <= horizon && k < 480; due = addMonths(loan.first_payment_date, ++k)) {
    const hit = satisfied.get(due);
    installments.push({ due_date: due, pi_cents: terms.pi_cents, escrow_cents: escrowPortionOn(terms, due), status: hit ? "satisfied" : "due", ...(hit ? { satisfied_on: hit.received_on, credited_as_of: hit.credited_as_of, satisfied_by_payment_id: hit.payment_id } : {}) });
  }
  const fees: Fee[] = store.list("fees", (d) => d.loan_id === loanId && (d.fee_type === "late_charge" || d.fee_type === "nsf_fee")).map((r) => ({ id: r.id, fee_type: r.data.fee_type as Fee["fee_type"], installment_due_date: typeof r.data.installment_due_date === "string" ? D(r.data.installment_due_date) : null, amount_cents: c(r.data.amount_cents), state: (r.data.state as Fee["state"]) ?? "assessed", assessed_on: D(String(r.data.assessed_on)), ...(typeof r.data.grace_end_on === "string" ? { grace_end_on: D(r.data.grace_end_on) } : {}), collected_cents: c(r.data.collected_cents) } as Fee));
  const lcDue = fees.filter((f) => f.fee_type === "late_charge" && (f.state === "assessed" || f.state === "partially_collected")).reduce((a, f) => a + f.amount_cents - f.collected_cents, 0n);
  const lpi = [...satisfied.keys()].sort().at(-1) ?? null;
  const state: LoanCashState = { loan_id: loanId, instrument_date: loan.instrument_date, lien: "first", escrowed: terms.escrowed, note_rate_pct: (terms.note_rate_bps / 10_000).toFixed(3), remittance_type: "A/A", upb_cents: bal.principal, lpi_date: lpi ? D(lpi) : null, installments, late_charges_due_cents: lcDue, nsf_fees_due_cents: 0n, other_fees_due_cents: 0n, suspense_unapplied_cents: bal.suspense_unapplied > 0n ? bal.suspense_unapplied : 0n, holds: [], trial_active: false, plan_active: false, partial_count_12m: 0, opted_out_of_50_rule: false,
    late_charge_pct: terms.late_charge_pct, late_charge_grace_days: terms.late_charge_grace_days, late_charge_cap_cents: terms.late_charge_max_cents, late_charge_basis: "pi", fees, overlays: [], courtesy_waivers_12m: 0, loan_terms_version: 1 };
  return { loan, terms, custodial, state, store, balances: bal, received_payments: payments.filter((p) => p.status === "received" || p.status === "identified") };
}

// ---------------------------------------------------------------- parties and their consents (the recipients of every servicing notice)
export interface ServicingParty { readonly party_id: string; readonly legal_name: string; readonly email: string | null; readonly mailing_address: string | null; readonly esign: Consent | null; readonly irs_estatement: Consent | null; readonly consent_ids: { esign: string | null; irs_estatement: string | null }; }
const consentStatus = (v: unknown): ConsentStatus => { const st = String(v ?? "active"); if (st === "revoked") return "withdrawn"; return (["pending_verification", "active", "suspect", "reconsent_required", "withdrawn", "expired", "evidence_only"].includes(st) ? st : "evidence_only") as ConsentStatus; };
/** Every borrower party on the loan (the application's borrowers once funded; `borrowers.party_id` on a serviced loan) with the property's mailing address and the party's latest E-SIGN / IRS e-statement consents. */
export async function servicingParties(rt: Runtime, loanId: string): Promise<ServicingParty[]> {
  const rows = await rt.db.query<{ party_id: string; legal_name: string; contact: Record<string, unknown> | null }>(
    `SELECT DISTINCT ON (x.party_id) x.party_id, x.legal_name, p.contact FROM (
       SELECT ab.party_id, ab.legal_name, ab.created_at FROM application_borrowers ab JOIN applications a ON a.id = ab.application_id WHERE a.loan_id = $1 AND ab.party_id IS NOT NULL
       UNION ALL SELECT b.party_id, b.legal_name, b.created_at FROM borrowers b JOIN loan_borrowers lb ON lb.borrower_id = b.id WHERE lb.loan_id = $1 AND b.party_id IS NOT NULL) x JOIN parties p ON p.id = x.party_id ORDER BY x.party_id, x.created_at`, [loanId]);
  const prop = (await rt.db.query<Row>(`SELECT pr.address_line1, pr.city, pr.state, pr.postal_code FROM loans l JOIN properties pr ON pr.id = l.property_id WHERE l.id = $1`, [loanId]))[0];
  const address = prop ? `${String(prop.address_line1)}, ${String(prop.city)}, ${String(prop.state)} ${String(prop.postal_code)}` : null;
  const consents = rows.length ? await rt.db.query<Row>(`SELECT id, party_id, kind::text AS kind, status, scope, hw_sw_version, captured_at, verified FROM consents WHERE party_id = ANY($1::uuid[]) AND kind IN ('esign', 'irs_estatement') ORDER BY captured_at`, [rows.map((r) => r.party_id)]) : [];
  const consentOf = (partyId: string, kind: string): { consent: Consent | null; id: string | null } => {
    const row = consents.filter((x) => x.party_id === partyId && x.kind === kind).at(-1); if (!row) return { consent: null, id: null };
    const classes = kind === "irs_estatement" ? ["irs_estatement"] : Array.isArray(row.scope) ? (row.scope as string[]) : [];
    return { consent: { party_id: partyId, classes, disclosure_version: String(row.hw_sw_version ?? "2.0"), status: consentStatus(row.status), consented_on: D(String(row.captured_at).slice(0, 10)), soft_bounces_30d: 0 }, id: String(row.id) };
  };
  return rows.map((r) => { const e = consentOf(r.party_id, "esign"); const irs = consentOf(r.party_id, "irs_estatement"); const email = typeof r.contact?.["email"] === "string" ? (r.contact["email"] as string) : null; return { party_id: r.party_id, legal_name: r.legal_name, email, mailing_address: address, esign: e.consent, irs_estatement: irs.consent, consent_ids: { esign: e.id, irs_estatement: irs.id } }; });
}
export const recipientsOf = (parties: readonly ServicingParty[], consent: "esign" | "irs_estatement" = "esign"): Recipient[] => parties.map((p) => ({ partyId: p.party_id, name: p.legal_name, mailingAddress: p.mailing_address, ...(p.email ? { email: p.email } : {}), ...((consent === "irs_estatement" ? p.irs_estatement : p.esign) ? { consent: consent === "irs_estatement" ? p.irs_estatement! : p.esign! } : {}) }));

// ---------------------------------------------------------------- the daily sweep
export interface ServicingSweepReport { readonly at: string; readonly loans: number; readonly posted: string[]; readonly late_charge_runs: string[]; readonly amount_change_checks: string[]; readonly errors: { loan_id: string; step: string; error: string }[]; }
/** The next draft date of an active enrollment: `next_draft_on` when set, else the draft day in the month of the next due installment. */
function nextDraftOn(e: Row, state: LoanCashState, today: PlainDate): PlainDate | null {
  if (typeof e.next_draft_on === "string" && e.next_draft_on >= today) return D(e.next_draft_on);
  const due = state.installments.find((x) => x.status === "due" && x.due_date >= addDays(today, -30));
  if (!due) return null;
  const day = Math.min(Number(e.draft_day ?? 1), 28);
  return D(`${due.due_date.slice(0, 8)}${String(day).padStart(2, "0")}`);
}
export async function servicingDailySweep(rt: Runtime, nowIso: string = rt.clock.now()): Promise<ServicingSweepReport> {
  const today = D(nowIso.slice(0, 10));
  const report: ServicingSweepReport = { at: nowIso, loans: 0, posted: [], late_charge_runs: [], amount_change_checks: [], errors: [] };
  const loans = await rt.db.query<{ id: string }>(`SELECT id FROM loans WHERE boarded_at IS NOT NULL AND origination_application_id IS NOT NULL AND status NOT IN ('paid_off', 'transferred_out', 'repurchased', 'charged_off') ORDER BY boarded_at`);
  for (const { id: loanId } of loans) {
    (report as { loans: number }).loans += 1;
    try {
      let facts = await loanCashState(rt, loanId, today);
      // 2.1: post every received payment through the allocation engine (a partial opens the 2.2 hold)
      if (facts.custodial) for (const p of facts.received_payments) {
        await rt.execute({ process: "2.1", name: "payments.read/write", loanId, actor: CASHIERING_AGENT, input: { op: "post", id: String(p.payment_id), loan_id: loanId, state: facts.state, custodial: facts.custodial } });
        report.posted.push(String(p.payment_id)); facts = await loanCashState(rt, loanId, today);
      }
      // 2.7: the 00:30 run on a due date (installment.due_date_reached) and the day after a grace end (the assessment decision)
      const dueToday = facts.state.installments.some((x) => x.due_date === today);
      const graceYesterday = facts.state.installments.some((x) => x.status === "due" && graceEndFor(facts.state, x.due_date) === addDays(today, -1));
      if (dueToday || graceYesterday) {
        const backlog = facts.received_payments.filter((p) => String(p.received_on ?? "") <= today).length;
        await rt.execute({ process: "2.7", name: "fees.assess", loanId, actor: CASHIERING_AGENT, input: { op: "daily_run", state: facts.state, run_on: today, facts: { items_received_or_identified_on_or_before_gate_date: backlog, run_on: today }, unposted_receipts_on_or_before_grace: backlog } });
        report.late_charge_runs.push(loanId);
      }
      // 2.3 rule 5: a changed draft amount within the 30-day window needs the Reg E notice (or the escrow statement that stated it)
      for (const rec of facts.store.list("autodraft_enrollments", (d) => d.loan_id === loanId && d.status === "active")) {
        const e = rec.data; if (e.last_debit_cents === null || e.last_debit_cents === undefined) continue;
        const debitOn = nextDraftOn(e, facts.state, today); if (!debitOn || debitOn < today || debitOn > addDays(today, 31)) continue;
        const inst = facts.state.installments.find((x) => x.due_date.slice(0, 7) === debitOn.slice(0, 7)) ?? facts.state.installments.find((x) => x.status === "due");
        if (!inst) continue;
        const next = inst.pi_cents + inst.escrow_cents + c(e.extra_principal_cents);
        if (next === c(e.last_debit_cents)) continue;
        const notices = Array.isArray(e.notices) ? (e.notices as Row[]) : [];
        if (notices.some((n) => c(n.amount_cents) === next && n.debit_on === debitOn)) continue;   // already noticed (or the statement stated it)
        const stmt = (await rt.uow.events.byLoan(loanId)).filter((x) => x.type === "escrow.statement.sent" && typeof (x.payload as Row).stated_payment_cents === "string").at(-1);
        const parties = await servicingParties(rt, loanId);
        await rt.execute({ process: "2.3", name: "autodraft.read/write", loanId, actor: CASHIERING_AGENT, input: { op: "amount_change_check", id: rec.id, loan_id: loanId, next_amount_cents: s(next), debit_on: debitOn, today, prior_amount_cents: String(e.last_debit_cents), reason: "your escrow payment changed after the annual escrow analysis", recipients: recipientsOf(parties),
          ...(stmt ? { statement: { template: String((stmt.payload as Row).template), sent_on: String((stmt.payload as Row).sent_on), amount_cents: String((stmt.payload as Row).stated_payment_cents), debit_on: String((stmt.payload as Row).stated_payment_effective_on) } } : {}) } });
        report.amount_change_checks.push(rec.id);
      }
    } catch (e) { report.errors.push({ loan_id: loanId, step: "sweep", error: e instanceof Error ? e.message : String(e) }); }
  }
  return report;
}

// ---------------------------------------------------------------- 7.1: the periodic statement run
export interface StatementRunInput { readonly cycle_due_date: PlainDate; readonly statement_date?: PlainDate; readonly cycle?: number; readonly now?: string; }
export interface StatementRunResult { readonly notice_id: string; readonly availability_notice_id: string | null; readonly channel: "electronic" | "mail"; readonly bounced_party_ids: string[]; readonly mailed_at: string | null; readonly statement_date: PlainDate; readonly events: readonly { type: string; payload: Record<string, unknown> }[]; }
function statementPayload(f: LoanFacts, borrowerName: string, statementDate: PlainDate, due: PlainDate): Record<string, unknown> {
  const st = f.state; const inst = st.installments.find((x) => x.due_date === due) ?? st.installments[st.installments.length - 1]!;
  const interest = divRound(st.upb_cents * BigInt(f.terms.note_rate_bps), 12_000_000n, "HALF_UP"); const principal = inst.pi_cents - interest; const escrow = inst.escrow_cents;
  const pastDue = st.installments.filter((x) => x.status === "due" && x.due_date < due).reduce((a, x) => a + x.pi_cents + x.escrow_cents, 0n);
  const lc = st.late_charges_due_cents; const amountDue = inst.pi_cents + inst.escrow_cents + pastDue + lc;
  const year = statementDate.slice(0, 4);
  const posted = f.store.list("payments", (d) => d.loan_id === f.loan.id && d.status === "posted").map((r) => r.data).sort((a, b) => String(a.received_on).localeCompare(String(b.received_on)));
  const alloc = (p: Row, k: string): Cents => c((p.allocation as Row | undefined)?.[k]);
  const lastPay = posted.filter((p) => String(p.received_on) >= addMonths(statementDate, -1) && String(p.received_on) <= statementDate);
  const sum = (ps: Row[], k: string) => ps.reduce((a, p) => a + alloc(p, k), 0n); const total = (ps: Row[]) => ps.reduce((a, p) => a + c(p.amount_cents), 0n);
  const ytd = posted.filter((p) => String(p.received_on).startsWith(year));
  const suspense = st.suspense_unapplied_cents; const heldItem = f.store.list("suspense_items", (d) => d.loan_id === f.loan.id && d.status === "open")[0]?.data;
  const lateFeeDebits = (st.fees ?? []).filter((x) => x.fee_type === "late_charge" && x.assessed_on > addMonths(statementDate, -1) && x.assessed_on <= statementDate);
  const unpaidPast = st.installments.filter((x) => x.status === "due" && x.due_date < statementDate).sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
  const regxDays = unpaidPast ? Math.max(0, Math.round((Date.parse(statementDate) - Date.parse(unpaidPast.due_date)) / 86_400_000)) : 0;
  const disclosure = lateFeeDisclosure(st, due);
  return { statement_date: statementDate, due_date: due, amount_due_cents: amountDue, computed_amount_due_cents: amountDue, late_fee_after_date: disclosure.late_fee_date, late_fee_cents: disclosure.late_fee_amount_if_unpaid, principal_cents: principal, interest_cents: interest, escrow_cents: escrow, fees_since_last_cents: lateFeeDebits.reduce((a, x) => a + x.amount_cents, 0n), past_due_cents: pastDue, late_charges_due_cents: lc,
    payments_since_last: { total_cents: total(lastPay), principal_cents: sum(lastPay, "principal_cents"), interest_cents: sum(lastPay, "interest_cents"), escrow_cents: sum(lastPay, "escrow_cents"), fees_cents: sum(lastPay, "late_charge_cents"), suspense_cents: 0n },
    ytd: { total_cents: total(ytd), principal_cents: sum(ytd, "principal_cents"), interest_cents: sum(ytd, "interest_cents"), escrow_cents: sum(ytd, "escrow_cents"), fees_cents: sum(ytd, "late_charge_cents"), suspense_held_cents: suspense }, ytd_ledger_total_cents: total(ytd),
    ...(suspense > 0n ? { suspense_instructions: `We received ${usd(suspense)}, which is being held. We need ${usd(c(heldItem?.balance_needed_cents))} more to apply a full payment.` } : {}),
    transactions: [...lastPay.map((p) => ({ date: String(p.received_on), description: "Payment received", amount_cents: c(p.amount_cents) })), ...lateFeeDebits.map((x) => ({ date: x.assessed_on, description: "Late fee", amount_cents: x.amount_cents }))], late_fee_debits: lateFeeDebits.length,
    servicer_phone: SERVICER_CONTACT.servicer_phone, servicer_address: SERVICER_CONTACT.servicer_address, exclusive_address: SERVICER_CONTACT.exclusive_address, account_last4: f.loan.servicer_loan_number.slice(-4), upb_cents: st.upb_cents, rate_pct: st.note_rate_pct, prepay_penalty: false, counselor_url: SERVICER_CONTACT.counselor_url, hud_phone: SERVICER_CONTACT.hud_phone,
    regx_days_delinquent: regxDays, borrower_name: borrowerName, reminder_panel: false, delinquency: null };
}
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd = (v: Cents): string => USD.format(Number(v) / 100);
/** The FAKE print/mail vendor's production run (a real vendor manifests overnight; the fake mails on request) — the paper piece leaves the same day. */
const runProduction = (rt: Runtime, nowIso: string): void => { const pm = rt.ports.printMail as { runProduction?: (now: string) => void } | undefined; pm?.runProduction?.(nowIso); };

/** 7.1's cycle run for one statement — see the header. Returns the facts the flow and the tests read back. */
export async function sendPeriodicStatement(rt: Runtime, loanId: string, input: StatementRunInput): Promise<StatementRunResult> {
  const nowIso = input.now ?? rt.clock.now(); const statementDate = input.statement_date ?? D(nowIso.slice(0, 10));
  if (!rt.ports.printMail || !rt.ports.edelivery) throw new RangeError("print/mail and e-delivery ports are not wired");
  const facts = await loanCashState(rt, loanId, statementDate); const parties = await servicingParties(rt, loanId);
  const suspect: { party_id: string; consent_id: string | null }[] = [];
  let result: StatementRunResult | null = null;
  const r = await rt.uow.run({ loanId, ...(facts.loan.origination_application_id ? { applicationId: facts.loan.origination_application_id } : {}) }, async (ctx) => {
    const notices = new NoticeService({ registry: rt.noticeRegistry, events: ctx.events, clock: ctx.clock, printMail: rt.ports.printMail!, edelivery: rt.ports.edelivery! });
    const cycles = new StatementCycleService({ events: ctx.events, clock: ctx.clock, notices });
    const recipients = recipientsOf(parties);
    // comment 41(c)-3: the availability e-mail goes to every party whose active consent covers periodic statements; a hard bounce flips that party's consent to suspect (7.4 rule 8) before the statement's own channel decision
    const electronic = recipients.filter((x) => x.consent?.status === "active" && x.consent.classes.includes("periodic_statements") && x.email);
    let availabilityId: string | null = null; const bounced: string[] = [];
    if (electronic.length) {
      const avail = notices.render({ templateCode: "NTC_REGZ_41_STMT_AVAIL_EMAIL", loanId, recipients: electronic, payload: { statement_date: statementDate, account_last4: facts.loan.servicer_loan_number.slice(-4), portal_url: SERVICER_CONTACT.portal_url, consent_status: "active", servicer_phone: SERVICER_CONTACT.servicer_phone }, asOf: statementDate });
      const sent = await notices.send(avail.id); availabilityId = sent.id;
      for (const d of sent.deliveries) if (d.emailStatus === "bounced") {
        const party = parties.find((p) => p.party_id === d.partyId); bounced.push(d.partyId);
        recordBounceSuspect({ events: ctx.events }, { loan_id: loanId, party_id: d.partyId, consent_id: party?.consent_ids.esign ?? null, notice_id: sent.id, template: sent.templateCode, bounced_at: d.submittedAt, fallback_mailed_at: nowIso });
        suspect.push({ party_id: d.partyId, consent_id: party?.consent_ids.esign ?? null });
      }
    }
    const rendered = cycles.renderStatement(loanId, { cycle_due_date: input.cycle_due_date, statement_date: statementDate, template: "NTC_REGZ_41_STMT_STD", variant: "standard", payload: statementPayload(facts, parties[0]?.legal_name ?? "Borrower", statementDate, input.cycle_due_date), recipients, reminder_panel: false, ...(input.cycle !== undefined ? { cycle: input.cycle } : {}) });
    if (rendered.status === "held") throw new RangeError(`statement held: ${rendered.held_reason}`);
    const out = await cycles.sendStatement(rendered.notice.id);
    let mailedAt: string | null = null; let channel: "electronic" | "mail" = "electronic";
    if (out.awaiting === "vendor_manifest") {
      // the paper statement: the FAKE print/mail vendor's production run is the same day (7.4 rule 8: "same-day mail of the affected notice"); the manifest closes the cycle with `statement.sent{mailed_at}`
      runProduction(rt, nowIso); mailedAt = nowIso; channel = "mail";
      const attempt = out.notice.deliveries.find((d) => d.channel.startsWith("mail"))!.attemptNo;
      cycles.recordStatementMailed(rendered.notice.id, { attempt_no: attempt, mailed_at: nowIso, proof_of_mailing_id: `POM-${rendered.notice.id}:${attempt}` });
    }
    for (const partyId of bounced) {
      ctx.events.append({ type: "statement.bounced", loanId, actor: STATEMENT_AGENT, payload: { cycle_due_date: input.cycle_due_date, statement_date: statementDate, party_id: partyId, availability_notice_id: availabilityId, notice_id: rendered.notice.id, reason: "hard bounce" } });
      ctx.events.append({ type: "statement.fallback_mailed", loanId, actor: STATEMENT_AGENT, payload: { cycle_due_date: input.cycle_due_date, statement_date: statementDate, party_id: partyId, notice_id: rendered.notice.id, mailed_at: mailedAt, same_day: mailedAt !== null && mailedAt.slice(0, 10) === nowIso.slice(0, 10), consent_status: "suspect" } });
    }
    result = { notice_id: rendered.notice.id, availability_notice_id: availabilityId, channel, bounced_party_ids: bounced, mailed_at: mailedAt, statement_date: statementDate, events: [] };
    return result;
  }, { clock: rt.clock, commit: async (q) => { for (const x of suspect) await q.query(`UPDATE consents SET status = 'suspect' WHERE party_id = $1 AND kind = 'esign' AND status = 'active'`, [x.party_id]); } });
  return { ...(result as unknown as StatementRunResult), events: r.events.map((e) => ({ type: e.type, payload: e.payload as Record<string, unknown> })) };
}

// ---------------------------------------------------------------- 7.1-A / 7.4 rule 11: Form 1098
export interface Form1098Result { readonly notice_id: string; readonly channel: "electronic" | "paper"; readonly gate_open: boolean; readonly box1_cents: string; readonly box2_cents: string; readonly furnished_on: PlainDate; }
export async function furnishForm1098(rt: Runtime, loanId: string, input: { tax_year: number; furnished_on?: PlainDate; now?: string }): Promise<Form1098Result> {
  const nowIso = input.now ?? rt.clock.now(); const on = input.furnished_on ?? D(nowIso.slice(0, 10)); const y = input.tax_year;
  if (!rt.ports.printMail || !rt.ports.edelivery) throw new RangeError("print/mail and e-delivery ports are not wired");
  const facts = await loanCashState(rt, loanId, on); const parties = await servicingParties(rt, loanId); const payer = parties[0];
  if (!payer) throw new RangeError("no borrower party on the loan");
  // box 1 from the ledger: interest credited to interest_due by the year's allocation sets; box 2: the principal balance at the year's start
  const interest = (await rt.db.query<{ s: string }>(`SELECT coalesce(-sum(l.amount_cents), 0)::text AS s FROM ledger_lines l JOIN ledger_entry_sets e ON e.id = l.set_id WHERE l.scope = 'loan' AND l.loan_id = $1 AND l.account = 'interest_due' AND l.amount_cents < 0 AND e.effective_date >= $2::date AND e.effective_date < $3::date`, [loanId, `${y}-01-01`, `${y + 1}-01-01`]))[0]!.s;
  const upbJan1 = (await rt.db.query<{ s: string }>(`SELECT coalesce(sum(l.amount_cents), 0)::text AS s FROM ledger_lines l JOIN ledger_entry_sets e ON e.id = l.set_id WHERE l.scope = 'loan' AND l.loan_id = $1 AND l.account = 'principal' AND e.effective_date < $2::date`, [loanId, `${y}-01-01`]))[0]!.s;
  const prop = (await rt.db.query<Row>(`SELECT pr.address_line1, pr.city, pr.state, pr.postal_code FROM loans l JOIN properties pr ON pr.id = l.property_id WHERE l.id = $1`, [loanId]))[0];
  let result: Form1098Result | null = null;
  await rt.uow.run({ loanId, ...(facts.loan.origination_application_id ? { applicationId: facts.loan.origination_application_id } : {}) }, async (ctx) => {
    const notices = new NoticeService({ registry: rt.noticeRegistry, events: ctx.events, clock: ctx.clock, printMail: rt.ports.printMail!, edelivery: rt.ports.edelivery! });
    const cycles = new StatementCycleService({ events: ctx.events, clock: ctx.clock, notices });
    const gate = requestForm1098Furnish({ events: ctx.events }, { loan_id: loanId, tax_year: y, party_id: payer.party_id, channel: "electronic", consents: parties.flatMap((p) => (p.irs_estatement ? [p.irs_estatement] : [])) });
    const out = await cycles.furnish1098(loanId, { tax_year: y, interest_received_cents: c(interest), upb_jan1_cents: c(upbJan1), furnished_on: on, recipients: recipientsOf(parties, "irs_estatement"),
      payload: { servicer_name: SERVICER_CONTACT.servicer_name, servicer_tin: SERVICER_CONTACT.servicer_tin, payer_name: payer.legal_name, account_number: facts.loan.servicer_loan_number, property_address: prop ? `${String(prop.address_line1)}, ${String(prop.city)}, ${String(prop.state)} ${String(prop.postal_code)}` : payer.mailing_address ?? "", box3_origination_date: facts.loan.instrument_date, box4_cents: 0n, box5_cents: 0n, box6_cents: 0n, box10_cents: 0n, box11_acquisition_date: null, servicer_phone: SERVICER_CONTACT.servicer_phone, servicer_address: SERVICER_CONTACT.servicer_address, exclusive_address: SERVICER_CONTACT.exclusive_address } });
    if (out.channel === "paper") runProduction(rt, nowIso);
    result = { notice_id: out.notice.id, channel: out.channel, gate_open: gate.gate_open, box1_cents: s(out.box1_cents), box2_cents: s(out.box2_cents), furnished_on: on };
    return result;
  }, { clock: rt.clock });
  return result as unknown as Form1098Result;
}
