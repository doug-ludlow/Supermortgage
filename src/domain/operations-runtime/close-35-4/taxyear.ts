/**
 * §35.4 `close.tax_year` — rule 10. On the December period's `tax_year_close` step (planned at/after 2 January 00:05 ET):
 * the reportable set is every loan with `interest_due` credits from borrower funds in the calendar year (7.1 rule 11), the
 * 1099-INT set is every loan with escrow interest ≥ $10.00 (3.9), the 1099-A/C set is every loan with a 15.x acquisition,
 * a known abandonment or a discharge of debt in the year (filed by Supermortgage on Fannie Mae's behalf, C-4.2-01 / F-1-23;
 * the January 5 no-1099-C list is applied by the furnish step, never here). The unit calls 7.1's `closeTaxYear` and 3.9's
 * (their `tax_year.closed` events arm the IRS clocks per loan), writes `tax_year_closes` and the 1099-A/C filing-list
 * document, opens the kind `tax_year` close period with its six steps (a step with no loans skipped by the system), and
 * emits `close.tax_year.closed{tax_year, reportable_loans, ioe_1099_loans, form_1099_ac_loans}` — satisfying
 * `SM_TAX_YEAR_CLOSE_3BD`. Idempotent per tax year (a second pass changes nothing).
 */
import { createHash, randomUUID } from "node:crypto";
import type { CommandContext } from "../../../app/commands.ts";
import { PortUnavailable, type ToolInput, type ToolRuntime } from "../../../app/tools.ts";
import type { Runtime } from "../../../runtime/app.ts";
import type { NoticeService } from "../../../notices/service.ts";
import { StatementCycleService } from "../../notices/ops-7-1.ts";
import { EscrowInterest1099Service, type BorrowerTaxYear } from "../../escrow/ops-3-9.ts";
import { taxPeriodKey, taxYearEnd } from "./calendar.ts";
import { openClosePeriod } from "./open.ts";
import { closePorts } from "./ports.ts";
import { filedLoans, form1099AcLoans, ioe1099Loans, reportableLoans } from "./reads.ts";
import { journal, patchStep, periodByKey, stepOf, writeCloseDecision } from "./store.ts";
import { GLOBAL_AGG, CloseRefused } from "./types.ts";

const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };

export async function taxYearTool(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const q = ctx.q; if (!q) throw new RangeError("35.4 tools run inside a database command (PgUnitOfWork): no transaction on this context");
  const ty = Number(i["tax_year"]); if (!Number.isInteger(ty) || ty < 2000) throw new RangeError("tax_year must be a calendar year");
  const runtime = runtimeOf(rt); const servicer = await closePorts(runtime).servicer.servicerNumber(q);
  const existing = (await q.query<{ id: string; reportable_loans: number; ioe_1099_loans: number; form_1099_ac_loans: number; ledger_interest_sum_cents: string; tax_year_close_period_id: string | null }>(`SELECT id::text AS id, reportable_loans, ioe_1099_loans, form_1099_ac_loans, ledger_interest_sum_cents::text AS ledger_interest_sum_cents, tax_year_close_period_id::text AS tax_year_close_period_id FROM tax_year_closes WHERE tax_year = $1`, [ty]))[0];
  if (existing) return { ran: false, tax_year: ty, tax_year_close_id: existing.id, reportable_loans: existing.reportable_loans, ioe_1099_loans: existing.ioe_1099_loans, form_1099_ac_loans: existing.form_1099_ac_loans, ledger_interest_sum_cents: existing.ledger_interest_sum_cents, tax_year_close_period_id: existing.tax_year_close_period_id };
  const december = await periodByKey(q, "month", `${ty}-12`, servicer, true);
  if (!december) throw new CloseRefused("TAX_YEAR_NOT_READY", "35.4 rule 10: 'On the December period's tax_year_close step'", `no December ${ty} close period`);
  const step = await stepOf(q, december.id, "tax_year_close");
  if (!step) throw new CloseRefused("TAX_YEAR_NOT_READY", "35.4 rule 1: December adds `tax_year_close`", `December ${ty} has no tax_year_close step`);
  if (step.status === "blocked") throw new CloseRefused("STEP_BLOCKED", "35.4 rule 1: `tax_year_close` depends on `period_close` and `ledger_period_close`", `tax_year_close of ${ty}-12 is blocked`);
  if (step.not_before && step.not_before > ctx.now) throw new CloseRefused("NOT_BEFORE", "35.4 rule 1: `tax_year_close` carries not_before 2 Jan 00:05 ET (7.1's 'Jan 2, 00:05 ET')", `tax_year_close of ${ty} opens at ${step.not_before}`);
  // the sets, each from the owning section's own typed rows
  const reportable = await reportableLoans(q, ty); const ioe = await ioe1099Loans(q, ty); const ac = await form1099AcLoans(q, ty);
  const ledgerSum = reportable.reduce((a, l) => a + l.interest_cents, 0n);
  // 7.1: tax_year.closed per reportable loan (its clocks arm per loan); 7.1 refuses an empty list — nothing is emitted then (edge case)
  if (reportable.length) new StatementCycleService({ events: ctx.events, clock: ctx.clock, notices: rt.notices as NoticeService }).closeTaxYear({ tax_year: ty, reportable_loans: reportable.map((l) => l.loan_id) });
  // 3.9: per borrower, the loans whose escrow interest reached $10.00 — the same service the section runs
  let ioeLoans = 0;
  if (ioe.length) {
    // the borrower per loan (ids only — the TIN hash is 3.9's own, computed from the encrypted TIN by its solicitation path; never derived from tin_last4 here)
    const rows = await q.query<{ loan_id: string; borrower_id: string | null }>(`SELECT l.id::text AS loan_id, lb.borrower_id::text AS borrower_id FROM loans l LEFT JOIN loan_borrowers lb ON lb.loan_id = l.id AND lb.is_primary WHERE l.id = ANY($1::uuid[])`, [ioe.map((x) => x.loan_id)]);
    const byBorrower = new Map<string, { borrower_id: string; tin_hash: string | null; loan_ids: string[] }>();
    for (const r of rows) { const k = r.borrower_id ?? r.loan_id; const b = byBorrower.get(k) ?? { borrower_id: k, tin_hash: null, loan_ids: [] }; b.loan_ids.push(r.loan_id); byBorrower.set(k, b); }
    const borrowers: BorrowerTaxYear[] = [...byBorrower.values()];
    const r = new EscrowInterest1099Service(ctx.events, { kind: "agent", id: "escrow" }).closeTaxYear(ty, borrowers, { other_information_returns: reportable.length + ac.length });
    ioeLoans = r.reportable_loans.length + r.already_closed.length;
  }
  // the 1099-A/C filing list — Supermortgage's own worklist for the filing on Fannie Mae's behalf and the Form 1100 summary (never a hand-off list)
  const list = { process: "35.4", tax_year: ty, filer: { name: "Fannie Mae", tin: "52-0883107", note: "filed electronically by Supermortgage on Fannie Mae's behalf (Servicing Guide C-4.2-01 / F-1-23); Form 1100 to Fannie Mae; the January 5 no-1099-C list is applied by form_1099_ac_furnish" }, loans: ac.map((x) => ({ loan_id: x.loan_id, form: `1099-${x.kind}`, event_type: x.event_type, event_id: x.event_id })), generated_at: ctx.now };
  const bytes = Buffer.from(JSON.stringify(list, null, 1), "utf8"); const sha = createHash("sha256").update(bytes).digest("hex"); const docId = randomUUID();
  await q.query(`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata) VALUES ($1, 'irs_1099ac_filing_list', $2, $3, $4, 'application/json', 'tax_4y', $5::jsonb)`, [docId, sha, bytes.length, `close-35-4://tax_year/${ty}/1099ac-filing-list.json`, JSON.stringify({ tax_year: ty, loans: ac.length, process: "35.4" })]);
  if ((await q.query<{ r: string | null }>(`SELECT to_regclass('public.document_blobs')::text AS r`))[0]?.r) await q.query(`INSERT INTO document_blobs (document_id, sha256, byte_size, mime_type, content, staged_at) VALUES ($1, $2, $3, 'application/json', $4, $5)`, [docId, sha, bytes.length, bytes, ctx.now]);   // 35.2's staged copy, in the command's transaction (a failure fails the command — never swallowed inside a transaction)
  // the kind tax_year close period with its six steps; a step with no loans is skipped by the system
  const counts = { reportable_loans: reportable.length, filed_loans: filedLoans(reportable), ioe_1099_loans: ioeLoans, form_1099_ac_loans: ac.length };
  const opened = await openClosePeriod({ ...ctx, actor: { kind: "system", id: "close-planner" } }, { period: taxPeriodKey(ty), servicer_number: servicer, source_event_id: null }, { kind: "tax_year", tax_year: ty, counts });
  const closeId = randomUUID();
  const ev = ctx.events.append({ type: "close.tax_year.closed", aggregate: GLOBAL_AGG, actor: ctx.actor, payload: { tax_year: ty, tax_year_end: taxYearEnd(ty), reportable_loans: reportable.length, ioe_1099_loans: ioeLoans, form_1099_ac_loans: ac.length, ledger_interest_sum_cents: ledgerSum.toString(), tax_year_close_id: closeId, december_close_period_id: december.id, tax_year_close_period_id: opened.period.id, filing_list_document_id: docId, servicer_number: servicer } });
  await q.query(`INSERT INTO tax_year_closes (id, tax_year, december_close_period_id, tax_year_close_period_id, reportable_loans, ioe_1099_loans, form_1099_ac_loans, ledger_interest_sum_cents, filing_list_document_id, receipt_event_id, closed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [closeId, ty, december.id, opened.period.id, reportable.length, ioeLoans, ac.length, ledgerSum, docId, ev.id, ctx.now]);
  await patchStep(q, step.id, { status: "completed", started_at: step.started_at ?? ctx.now, completed_at: ctx.now, received: 1 }, ctx.now);
  await journal(q, { close_period_id: december.id, step_id: step.id, type: "close.tax_year.closed", actor: ctx.actor, occurred_at: ctx.now, payload: { tax_year: ty, tax_year_close_id: closeId, reportable_loans: reportable.length, ioe_1099_loans: ioeLoans, form_1099_ac_loans: ac.length, ledger_interest_sum_cents: ledgerSum.toString(), event_id: ev.id } });
  await journal(q, { close_period_id: december.id, step_id: step.id, type: "close.step.completed", actor: ctx.actor, occurred_at: ctx.now, payload: { period: december.period, step: "tax_year_close", tax_year: ty } });
  await writeCloseDecision(ctx, { action: "close.tax_year", subject: { kind: "tax_year", id: String(ty) }, record: { period: december.period, servicer_number: servicer, tax_year: ty, action: "tax_year_close", tax_year_close_id: closeId, reportable_loans: reportable.length, ioe_1099_loans: ioeLoans, form_1099_ac_loans: ac.length, ledger_interest_sum_cents: ledgerSum.toString(), filing_list_document_id: docId, tax_year_close_period_id: opened.period.id }, rationale: `tax year ${ty} closed: ${reportable.length} reportable loan(s), ledger interest ${ledgerSum} cents, ${ioeLoans} 1099-INT loan(s), ${ac.length} 1099-A/C loan(s)`, evidenceDocumentIds: [docId] });
  return { ran: true, tax_year: ty, tax_year_close_id: closeId, reportable_loans: reportable.length, ioe_1099_loans: ioeLoans, form_1099_ac_loans: ac.length, ledger_interest_sum_cents: ledgerSum.toString(), filing_list_document_id: docId, tax_year_close_period_id: opened.period.id, steps: opened.steps };
}
