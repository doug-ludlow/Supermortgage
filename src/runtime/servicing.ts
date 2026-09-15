/**
 * The servicing-side scheduled passes the hosted runtime runs for a boarded loan (the "daily sweeps" of 2.1, 2.3 and 2.7
 * and the 7.1 statement / 1098 runs), each executed through the owning process's own bus tool or service inside a unit
 * of work — the same path the borrower flows of section 32 read from (docs/ux/BACKEND-DELTAS.md, 32.8):
 *
 *   loanCashState(rt, loanId, asOf)     the 2.x LoanCashState of a boarded loan, built from `loans`, `loan_terms` (+ the 3.6
 *                                        loan_terms version in the entity store), the `loan_installments` rows 35.5 wrote (rule 4),
 *                                        the ledger balances, the `payments` rows and the `fees` rows — never a hand-fed figure
 *                                        (src/domain/operations-runtime/cashiering-cycle.ts loanCashStateFromRows).
 *   servicingDailySweep(rt, nowIso)     35.5 rule 6: one cashiering unit per loan per day over the WHOLE book (cashiering-cycle.ts
 *                                        cashieringDailyRun): 2.1 `payments.read/write{op=post}` for each received payment (the
 *                                        allocation engine; a partial opens the 2.2 suspense item), 2.7 `fees.assess{op=daily_run}`
 *                                        on a due date or the day after a grace end (`installment.due_date_reached` → the
 *                                        NOTE_6A grace gate; `fee.assessed{late_charge}`), and 2.3 `autodraft.read/write
 *                                        {op=amount_change_check}` when the next draft's amount differs from the last debit
 *                                        (Reg E §1005.10(d)(1): the escrow statement that stated the exact amount and date
 *                                        satisfies it; otherwise `AUTODRAFT-AMOUNT-CHANGE-v1` ≥ 10 days before the draft) — each
 *                                        loan-day one transaction, the `cashiering_daily` cycle row and the day's receipt.
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
import { NoticeService } from "../notices/service.ts";
import type { Actor } from "../kernel/events/index.ts";
import { plainDate as D, addMonths, type PlainDate } from "../kernel/calendar/date.ts";
import { divRound } from "../kernel/money/decimal.ts";
import type { Cents } from "../kernel/money/cents.ts";
import { lateFeeDisclosure } from "../domain/cashiering/latecharges.ts";
import { StatementCycleService } from "../domain/notices/ops-7-1.ts";
import { DISCLOSURES_AGENT as STATEMENT_AGENT } from "../notices/service.ts";   // the `disclosures` agent constant lives in src/notices/service.ts (ops-7-1.ts exports none) — import path corrected by the 32.5 build to unblock the shared journey fixture
import { requestForm1098Furnish, recordBounceSuspect } from "../domain/notices/ops-7-4.ts";
import { escrowPortionOn, type LoanTerms } from "../domain/operations-runtime/installments.ts";
import { servicerBlockFor, type ServicerBlock } from "../domain/operations-runtime/servicing-config.ts";
import { cashieringDailyRun, loanCashStateFromRows, type LoanFacts, type LoanRow } from "../domain/operations-runtime/cashiering-cycle.ts";
import { recipientsOf, servicingParties, type ServicingParty } from "./servicing-parties.ts";
import type { Runtime } from "./app.ts";

// 35.5 rule 4 / rule 9: the schedule arithmetic and the terms type live with the schedule (src/domain/operations-runtime/installments.ts); the state is
// derived from the rows there (cashiering-cycle.ts loanCashStateFromRows); the parties and recipients moved to ./servicing-parties.ts — the importers of this module keep their names
export { escrowPortionOn, type LoanTerms, type LoanFacts, type LoanRow, recipientsOf, servicingParties, type ServicingParty };

export const CASHIERING_AGENT: Actor = { kind: "agent", id: "cashiering" };
// The servicer block every servicing notice carries is the loan's `servicer_profiles` version in force on the notice date (35.5 rule 9,
// src/domain/operations-runtime/servicing-config.ts servicerBlockFor) — the FAKE build's seeded version 1 carries the former constant's values.
type Row = Record<string, unknown>;
const c = (v: unknown): Cents => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v)));
const s = (v: Cents): string => v.toString();

/** The 2.x LoanCashState of a boarded loan as of a date — 35.5 rule 4: built from the `loan_installments` rows (src/domain/operations-runtime/cashiering-cycle.ts), the ledger and the entity rows; never a hand-fed figure. */
export async function loanCashState(rt: Runtime, loanId: string, asOf: PlainDate): Promise<LoanFacts> { return loanCashStateFromRows(rt.db, loanId, asOf); }

// ---------------------------------------------------------------- the daily sweep
export interface ServicingSweepReport { readonly at: string; readonly loans: number; readonly posted: string[]; readonly late_charge_runs: string[]; readonly amount_change_checks: string[]; readonly errors: { loan_id: string; step: string; error: string }[]; }
/**
 * 35.5 rule 6: the whole book's cashiering units for the day (src/domain/operations-runtime/cashiering-cycle.ts cashieringDailyRun — one unit of
 * work per loan per day, 2.1 posting, 2.7's daily run and 2.3's amount-change check in-process, the `cashiering_daily` cycle row and the day's receipt
 * `cashiering.daily.run_completed`), reported in the shape the flows and the demo advance read. A loan without a configuration row is skipped
 * (CONFIG_REQUIRED, its own failed unit row) and is not an error of the pass.
 */
export async function servicingDailySweep(rt: Runtime, nowIso: string = rt.clock.now()): Promise<ServicingSweepReport> {
  const r = await cashieringDailyRun(rt, nowIso);
  return { at: r.at, loans: r.loans, posted: r.posted, late_charge_runs: r.late_charge_runs, amount_change_checks: r.amount_change_checks, errors: r.errors };
}

// ---------------------------------------------------------------- 7.1: the periodic statement run
export interface StatementRunInput { readonly cycle_due_date: PlainDate; readonly statement_date?: PlainDate; readonly cycle?: number; readonly now?: string; }
export interface StatementRunResult { readonly notice_id: string; readonly availability_notice_id: string | null; readonly channel: "electronic" | "mail"; readonly bounced_party_ids: string[]; readonly mailed_at: string | null; readonly statement_date: PlainDate; readonly events: readonly { type: string; payload: Record<string, unknown> }[]; }
function statementPayload(f: LoanFacts, borrowerName: string, statementDate: PlainDate, due: PlainDate, block: ServicerBlock): Record<string, unknown> {
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
    // the servicer block of the profile version in force on the statement date (35.5 rule 9; §1024.35(c) exclusive address on every periodic statement)
    servicer_name: block.servicer_name, servicer_phone: block.servicer_phone, servicer_address: block.servicer_address, exclusive_address: block.exclusive_address, remittance_address: block.remittance_address, portal_url: block.portal_url, account_last4: f.loan.servicer_loan_number.slice(-4), upb_cents: st.upb_cents, rate_pct: st.note_rate_pct, prepay_penalty: false, counselor_url: block.counselor_url, hud_phone: block.hud_phone,
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
  const block = await servicerBlockFor(rt.db, loanId, statementDate);   // 35.5 rule 9: the servicer identity as of the statement date (CONFIG_REQUIRED when none is in force)
  const suspect: { party_id: string; consent_id: string | null }[] = [];
  let result: StatementRunResult | null = null;
  const r = await rt.uow.run({ loanId, ...(facts.loan.origination_application_id ? { applicationId: facts.loan.origination_application_id } : {}) }, async (ctx) => {
    const notices = new NoticeService({ registry: rt.noticeRegistry, events: ctx.events, clock: ctx.clock, printMail: rt.ports.printMail!, edelivery: rt.ports.edelivery!, notices: rt.noticeMemory });   // the runtime's notice memory (32.12): the rendered statement / 1098 is readable after the run like any command's notice
    const cycles = new StatementCycleService({ events: ctx.events, clock: ctx.clock, notices });
    const recipients = recipientsOf(parties);
    // comment 41(c)-3: the availability e-mail goes to every party whose active consent covers periodic statements; a hard bounce flips that party's consent to suspect (7.4 rule 8) before the statement's own channel decision
    const electronic = recipients.filter((x) => x.consent?.status === "active" && x.consent.classes.includes("periodic_statements") && x.email);
    let availabilityId: string | null = null; const bounced: string[] = [];
    if (electronic.length) {
      const avail = notices.render({ templateCode: "NTC_REGZ_41_STMT_AVAIL_EMAIL", loanId, recipients: electronic, payload: { statement_date: statementDate, account_last4: facts.loan.servicer_loan_number.slice(-4), portal_url: block.portal_url, consent_status: "active", servicer_phone: block.servicer_phone }, asOf: statementDate });
      const sent = await notices.send(avail.id); availabilityId = sent.id;
      for (const d of sent.deliveries) if (d.emailStatus === "bounced") {
        const party = parties.find((p) => p.party_id === d.partyId); bounced.push(d.partyId);
        recordBounceSuspect({ events: ctx.events }, { loan_id: loanId, party_id: d.partyId, consent_id: party?.consent_ids.esign ?? null, notice_id: sent.id, template: sent.templateCode, bounced_at: d.submittedAt, fallback_mailed_at: nowIso });
        suspect.push({ party_id: d.partyId, consent_id: party?.consent_ids.esign ?? null });
      }
    }
    const rendered = cycles.renderStatement(loanId, { cycle_due_date: input.cycle_due_date, statement_date: statementDate, template: "NTC_REGZ_41_STMT_STD", variant: "standard", payload: statementPayload(facts, parties[0]?.legal_name ?? "Borrower", statementDate, input.cycle_due_date, block), recipients, reminder_panel: false, ...(input.cycle !== undefined ? { cycle: input.cycle } : {}) });
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
  const block = await servicerBlockFor(rt.db, loanId, on);   // 35.5 rule 9: the servicer's name, TIN and addresses on the 1098 are the profile's
  // box 1 from the ledger: interest credited to interest_due by the year's allocation sets; box 2: the principal balance at the year's start
  const interest = (await rt.db.query<{ s: string }>(`SELECT coalesce(-sum(l.amount_cents), 0)::text AS s FROM ledger_lines l JOIN ledger_entry_sets e ON e.id = l.set_id WHERE l.scope = 'loan' AND l.loan_id = $1 AND l.account = 'interest_due' AND l.amount_cents < 0 AND e.effective_date >= $2::date AND e.effective_date < $3::date`, [loanId, `${y}-01-01`, `${y + 1}-01-01`]))[0]!.s;
  const upbJan1 = (await rt.db.query<{ s: string }>(`SELECT coalesce(sum(l.amount_cents), 0)::text AS s FROM ledger_lines l JOIN ledger_entry_sets e ON e.id = l.set_id WHERE l.scope = 'loan' AND l.loan_id = $1 AND l.account = 'principal' AND e.effective_date < $2::date`, [loanId, `${y}-01-01`]))[0]!.s;
  const prop = (await rt.db.query<Row>(`SELECT pr.address_line1, pr.city, pr.state, pr.postal_code FROM loans l JOIN properties pr ON pr.id = l.property_id WHERE l.id = $1`, [loanId]))[0];
  let result: Form1098Result | null = null;
  await rt.uow.run({ loanId, ...(facts.loan.origination_application_id ? { applicationId: facts.loan.origination_application_id } : {}) }, async (ctx) => {
    const notices = new NoticeService({ registry: rt.noticeRegistry, events: ctx.events, clock: ctx.clock, printMail: rt.ports.printMail!, edelivery: rt.ports.edelivery!, notices: rt.noticeMemory });   // the runtime's notice memory (32.12): the rendered statement / 1098 is readable after the run like any command's notice
    const cycles = new StatementCycleService({ events: ctx.events, clock: ctx.clock, notices });
    const gate = requestForm1098Furnish({ events: ctx.events }, { loan_id: loanId, tax_year: y, party_id: payer.party_id, channel: "electronic", consents: parties.flatMap((p) => (p.irs_estatement ? [p.irs_estatement] : [])) });
    const out = await cycles.furnish1098(loanId, { tax_year: y, interest_received_cents: c(interest), upb_jan1_cents: c(upbJan1), furnished_on: on, recipients: recipientsOf(parties, "irs_estatement"),
      payload: { servicer_name: block.servicer_name, servicer_tin: block.servicer_tin, payer_name: payer.legal_name, account_number: facts.loan.servicer_loan_number, property_address: prop ? `${String(prop.address_line1)}, ${String(prop.city)}, ${String(prop.state)} ${String(prop.postal_code)}` : payer.mailing_address ?? "", box3_origination_date: facts.loan.instrument_date, box4_cents: 0n, box5_cents: 0n, box6_cents: 0n, box10_cents: 0n, box11_acquisition_date: null, servicer_phone: block.servicer_phone, servicer_address: block.servicer_address, exclusive_address: block.exclusive_address } });
    if (out.channel === "paper") runProduction(rt, nowIso);
    result = { notice_id: out.notice.id, channel: out.channel, gate_open: gate.gate_open, box1_cents: s(out.box1_cents), box2_cents: s(out.box2_cents), furnished_on: on };
    return result;
  }, { clock: rt.clock });
  return result as unknown as Form1098Result;
}
