/**
 * §35.12 rules 7–9 — the four-week parallel run against the incumbent servicer. `parallel_run.open` (officer): `parallel_runs{opened}`
 * with `planned_end_on = opened_on + 28 calendar days`, the loan set (`loan_ids | book: all`), `parallel_run.opened` on the global
 * subject (SM_PROD_GO_LIVE_ATTEST_GATE). `parallel_run.reconcile` (the 21:00 ET cycle or an officer): the incumbent's trial balance for
 * the day is a hashed `documents` row before anything reads it; per loan the eight fields of `parallel_run_diffs.field` — ours from the
 * typed rows through OurFiguresPort, theirs from the file; tolerance zero on every field; a mismatch opens a diff (one per loan, field
 * and day; a diff already open on the same loan and field for the same ours/theirs pair is not reopened); the day row carries
 * `comparisons = loans × 8`, `matched`, `mismatched`, `mismatch_cents = Σ |delta_cents|` over the day's mismatched money fields; the
 * daily report is a hashed document; `parallel_run.day.reconciled` (the global recurring clock SM_PROD_PARALLEL_RUN_DAILY); a day
 * already reconciled is DAY_ALREADY_RECONCILED. `parallel_run.disposition` (officer, a reason): ours_right | theirs_right | both_wrong |
 * timing — changes nothing on the book (NO_MONEY_FIELD; the owning section's command corrects ours); the agent proposes (`op: propose`)
 * with a confidence and never applies one. `parallel_run.close` (officer): `passed` only when as_of − opened_on ≥ 28, the last 7
 * reconciled days have no money mismatch (a missing day resets the count), no diff is open; else PARALLEL_RUN_TOO_SHORT{days} |
 * PARALLEL_RUN_OPEN_DIFFS{count} | PARALLEL_RUN_DIRTY_WEEK{days_clean}; `abandoned` with a reason at any time — the open gate instance
 * is cancelled (a new run re-arms it). An `extended` row (`parallel_run.open{op: extend}`) moves planned_end_on, cancels and re-arms the
 * gate and resets the clean-week count. Nothing here touches a borrower's money: ids, counts and the eight figures only.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { byOf } from "./decision.ts";
import { decisionFor, hashedDocument, personId, refuse, requireRole, requireRoleOrService, writeDocument, type PostureDeps } from "./deps.ts";
import { posturePortsOf, type OurFigures } from "./ports.ts";
import { CLEAN_WEEK_DAYS, DISPOSITIONS, ET, MONEY_FIELDS, P, PARALLEL_RUN_DAYS, RECONCILE_FIELDS, addCalendarDays, daysBetween, environmentOf, isUuid, obj, s, type Row } from "./types.ts";

export interface RunRow { readonly id: string; readonly parallel_run_id: string; readonly environment: string; readonly incumbent_servicer: string; readonly opened_on: string; readonly planned_end_on: string; readonly loan_count: number; readonly action: string; readonly as_of_date: string | null; readonly outcome: string | null; readonly loan_ids: string[]; readonly created_at: string }
const RUN_COLS = `id::text AS id, parallel_run_id::text AS parallel_run_id, environment, incumbent_servicer, opened_on::text AS opened_on, planned_end_on::text AS planned_end_on, loan_count, action, as_of_date::text AS as_of_date, outcome, loan_ids::text[] AS loan_ids, created_at::text AS created_at`;
export const OPEN_ROLES: readonly string[] = ["officer"];
const runAggregate = (id: string): { kind: string; id: string } => ({ kind: "parallel_run", id });
export const GATE_CODE = "SM_PROD_GO_LIVE_ATTEST_GATE";

/** The run's latest state row (opened | extended | closed decide the state; day rows are the days). */
export async function runState(q: Queryable, parallelRunId: string): Promise<RunRow | undefined> {
  if (!isUuid(parallelRunId)) return undefined;
  return (await q.query<RunRow & Record<string, unknown>>(`SELECT ${RUN_COLS} FROM parallel_runs WHERE parallel_run_id = $1 AND action IN ('opened', 'extended', 'closed') ORDER BY created_at DESC, id DESC LIMIT 1`, [parallelRunId]))[0];
}
export async function openRunOf(q: Queryable, environment: string): Promise<RunRow | undefined> {
  const rows = await q.query<RunRow & Record<string, unknown>>(`SELECT DISTINCT ON (parallel_run_id) ${RUN_COLS} FROM parallel_runs WHERE environment = $1 AND action IN ('opened', 'extended', 'closed') ORDER BY parallel_run_id, created_at DESC, id DESC`, [environment]);
  return rows.filter((r) => r.action !== "closed").sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}
export async function latestRunOf(q: Queryable, environment: string): Promise<RunRow | undefined> {
  const rows = await q.query<RunRow & Record<string, unknown>>(`SELECT DISTINCT ON (parallel_run_id) ${RUN_COLS} FROM parallel_runs WHERE environment = $1 AND action IN ('opened', 'extended', 'closed') ORDER BY parallel_run_id, created_at DESC, id DESC`, [environment]);
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}
/** The open gate instances on the global subject, cancelled (rule 9: an abandoned or extended run never satisfies the gate). */
function cancelGate(d: PostureDeps, reason: string): number {
  let n = 0;
  for (const t of d.timers.forSubject("global", "*")) if (t.code === GATE_CODE && (t.status === "armed" || t.status === "breached")) { d.timers.cancel(t.id, reason, d.actor); n++; }
  return n;
}

export interface OpenInput { readonly op?: string | null; readonly environment: string; readonly incumbent_servicer?: string | null; readonly loan_ids?: unknown; readonly book?: unknown; readonly opened_on?: string | null; readonly parallel_run_id?: string | null; readonly planned_end_on?: string | null; readonly reason?: string | null }
export interface OpenResult { readonly parallel_run_id: string; readonly environment: string; readonly incumbent_servicer: string; readonly opened_on: string; readonly planned_end_on: string; readonly loan_count: number; readonly action: "opened" | "extended"; readonly by: string }
export async function openRun(d: PostureDeps, i: OpenInput): Promise<OpenResult> {
  const environment = environmentOf(i.environment); const op = s(i.op) || "open";
  const officer = await requireRole(d, OPEN_ROLES, `parallel_run.open${op === "extend" ? ":extend" : ""}`, environment);
  const now = d.now; const by = personId(d.actor);
  if (op === "extend") {
    const run = await runState(d.db, s(i.parallel_run_id));
    if (!run || run.action === "closed") refuse(404, "RUN_NOT_OPEN", `no open parallel run ${s(i.parallel_run_id) || "(none)"}`, { parallel_run_id: i.parallel_run_id ?? null });
    const planned = s(i.planned_end_on); if (!/^\d{4}-\d{2}-\d{2}$/.test(planned) || planned <= run!.planned_end_on) throw new RangeError("planned_end_on moves forward (YYYY-MM-DD)");
    const reason = s(i.reason).trim(); if (!reason) throw new RangeError("an extension needs a reason");
    d.deferWrite(async (q) => { const decision_id = await decisionFor(q, "parallel_run", run!.parallel_run_id); await q.query(`INSERT INTO parallel_runs (parallel_run_id, environment, incumbent_servicer, opened_on, planned_end_on, loan_count, action, reason, by, decision_id, loan_ids, created_at) VALUES ($1, $2, $3, $4::date, $5::date, $6, 'extended', $7, $8, $9, $10::uuid[], $11::timestamptz)`, [run!.parallel_run_id, environment, run!.incumbent_servicer, run!.opened_on, planned, run!.loan_count, reason, by, decision_id, run!.loan_ids, now]); });
    cancelGate(d, `parallel run ${run!.parallel_run_id} extended to ${planned} (35.12 rule 9)`);
    d.events.append({ type: "parallel_run.opened", aggregate: runAggregate(run!.parallel_run_id), actor: d.actor, payload: P({ parallel_run_id: run!.parallel_run_id, environment, incumbent_servicer: run!.incumbent_servicer, opened_on: addCalendarDays(planned, -PARALLEL_RUN_DAYS), original_opened_on: run!.opened_on, planned_end_on: planned, loan_count: run!.loan_count, extended: true, reason, by: officer.id }) });
    return { parallel_run_id: run!.parallel_run_id, environment, incumbent_servicer: run!.incumbent_servicer, opened_on: run!.opened_on, planned_end_on: planned, loan_count: run!.loan_count, action: "extended", by: byOf(d.actor) };
  }
  if (op !== "open") throw new RangeError("parallel_run.open op ∈ {open, extend}");
  const incumbent = s(i.incumbent_servicer).trim() || "none";
  const opened_on = s(i.opened_on) || wallClock(Date.parse(now), ET).date; if (!/^\d{4}-\d{2}-\d{2}$/.test(opened_on)) throw new RangeError("opened_on is YYYY-MM-DD");
  const existing = await openRunOf(d.db, environment);
  if (existing) refuse(409, "RUN_ALREADY_OPEN", `${environment} already has an open parallel run ${existing.parallel_run_id} (opened ${existing.opened_on}); close it before opening another`, { parallel_run_id: existing.parallel_run_id });
  let loanIds: string[];
  if (i.book === "all" || i.book === true) loanIds = (await d.db.query<{ id: string }>(`SELECT id::text AS id FROM loans WHERE status::text IN ('active', 'boarded', 'reconciled') ORDER BY created_at, id`)).map((r) => r.id);
  else { loanIds = Array.isArray(i.loan_ids) ? (i.loan_ids as unknown[]).map(s) : []; if (loanIds.some((x) => !isUuid(x))) throw new RangeError("loan_ids are loans.id uuids"); const found = new Set((await d.db.query<{ id: string }>(`SELECT id::text AS id FROM loans WHERE id = ANY($1::uuid[])`, [loanIds])).map((r) => r.id)); const missing = loanIds.filter((x) => !found.has(x)); if (missing.length) throw new RangeError(`loan_ids not on the platform: ${missing.length}`); }
  const parallel_run_id = randomUUID(); const planned_end_on = addCalendarDays(opened_on, PARALLEL_RUN_DAYS);
  d.deferWrite(async (q) => { const decision_id = await decisionFor(q, "parallel_run", parallel_run_id); await q.query(`INSERT INTO parallel_runs (parallel_run_id, environment, incumbent_servicer, opened_on, planned_end_on, loan_count, action, by, decision_id, loan_ids, created_at) VALUES ($1, $2, $3, $4::date, $5::date, $6, 'opened', $7, $8, $9::uuid[], $10::timestamptz)`, [parallel_run_id, environment, incumbent, opened_on, planned_end_on, loanIds.length, by, decision_id, loanIds, now]); });
  cancelGate(d, `a new parallel run ${parallel_run_id} opened (35.12 rule 9)`);
  d.events.append({ type: "parallel_run.opened", aggregate: runAggregate(parallel_run_id), actor: d.actor, payload: P({ parallel_run_id, environment, incumbent_servicer: incumbent, opened_on, planned_end_on, loan_count: loanIds.length, by: officer.id }) });
  return { parallel_run_id, environment, incumbent_servicer: incumbent, opened_on, planned_end_on, loan_count: loanIds.length, action: "opened", by: byOf(d.actor) };
}

// ---- the incumbent's file --------------------------------------------------------------------------------------------
export interface IncumbentRow { readonly servicer_loan_number: string; readonly loan_id: string | null; readonly upb_cents: bigint; readonly escrow_balance_cents: bigint; readonly next_due_date: string | null; readonly late_charges_accrued_cents: bigint; readonly interest_paid_ytd_cents: bigint; readonly amount_due_cents: bigint; readonly days_delinquent: number; readonly form_496_remittance_cents: bigint }
const COLS: Readonly<Record<string, string[]>> = { servicer_loan_number: ["servicer_loan_number", "loan_number"], loan_id: ["loan_id", "supermortgage_loan_id"], upb: ["upb", "unpaid_principal_balance", "upb_cents"], escrow_balance: ["escrow_balance", "escrow_balance_cents"], next_due_date: ["next_due_date", "next_due"], late_charges_accrued: ["late_charges_accrued", "late_charges", "late_charges_accrued_cents"], interest_paid_ytd: ["interest_paid_ytd", "interest_ytd", "interest_paid_ytd_cents"], amount_due: ["amount_due", "current_amount_due", "amount_due_cents"], days_delinquent: ["days_delinquent", "dpd"], form_496_remittance: ["form_496_remittance", "remittance", "form_496_remittance_cents"] };
/** Dollars ("248,310.55", "$0.00", "-5.00") or cents (a `_cents` column) → bigint cents, half-up never needed: the file states cents exactly. */
export function moneyCents(v: string, isCents: boolean): bigint {
  const t = v.replace(/[$,\s]/g, ""); if (t === "" ) return 0n;
  if (isCents) { if (!/^-?\d+$/.test(t)) throw new RangeError(`not a cents figure: ${v}`); return BigInt(t); }
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(t); if (!m) throw new RangeError(`not a money figure: ${v}`);
  const cents = BigInt(m[2]!) * 100n + BigInt((m[3] ?? "0").padEnd(2, "0"));
  return m[1] === "-" ? -cents : cents;
}
/** The incumbent's trial balance as CSV (one row per loan; [UNVERIFIED format]): header names as COLS lists them. */
export function parseIncumbentFile(csv: string): IncumbentRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new RangeError("the incumbent file needs a header row and at least one loan row");
  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const idx = (k: string): number => { const names = COLS[k]!; const i = header.findIndex((h) => names.includes(h)); if (i < 0 && k !== "loan_id" && k !== "form_496_remittance") throw new RangeError(`the incumbent file lacks a ${k} column`); return i; };
  const at = (cells: string[], k: string): string => { const i = idx(k); return i < 0 ? "" : (cells[i] ?? "").trim(); };
  const isCents = (k: string): boolean => { const i = idx(k); return i >= 0 && header[i]!.endsWith("_cents"); };
  return lines.slice(1).map((line) => { const cells = line.split(","); const loanId = at(cells, "loan_id"); return { servicer_loan_number: at(cells, "servicer_loan_number"), loan_id: isUuid(loanId) ? loanId : null, upb_cents: moneyCents(at(cells, "upb"), isCents("upb")), escrow_balance_cents: moneyCents(at(cells, "escrow_balance"), isCents("escrow_balance")), next_due_date: at(cells, "next_due_date") || null, late_charges_accrued_cents: moneyCents(at(cells, "late_charges_accrued"), isCents("late_charges_accrued")), interest_paid_ytd_cents: moneyCents(at(cells, "interest_paid_ytd"), isCents("interest_paid_ytd")), amount_due_cents: moneyCents(at(cells, "amount_due"), isCents("amount_due")), days_delinquent: Number(at(cells, "days_delinquent") || 0), form_496_remittance_cents: idx("form_496_remittance") < 0 ? 0n : moneyCents(at(cells, "form_496_remittance"), isCents("form_496_remittance")) }; });
}
const fieldValue = (f: OurFigures | IncumbentRow, field: string): string => { const v = (f as unknown as Record<string, unknown>)[field]; return v === null || v === undefined ? "" : typeof v === "bigint" ? v.toString() : String(v); };

// ---- the reconciliation --------------------------------------------------------------------------------------------
export interface ReconcileInput { readonly parallel_run_id: string; readonly as_of_date: string; readonly incumbent_file_document_id?: string | null; readonly incumbent_file_csv?: string | null }
export interface DiffOpened { readonly diff_id: string; readonly loan_id: string; readonly field: string; readonly ours: string; readonly theirs: string; readonly delta_cents: string }
export interface ReconcileResult { readonly parallel_run_id: string; readonly environment: string; readonly as_of_date: string; readonly loans: number; readonly comparisons: number; readonly matched: number; readonly mismatched: number; readonly mismatch_cents: string; readonly diffs_opened: readonly DiffOpened[]; readonly diffs_already_open: number; readonly incumbent_file_document_id: string; readonly report_document_id: string; readonly by: string }
export const RECONCILE_ROLES: readonly string[] = ["officer"];
export async function dayReconciled(q: Queryable, parallelRunId: string, asOf: string): Promise<boolean> { return (await q.query(`SELECT 1 FROM parallel_runs WHERE parallel_run_id = $1 AND action = 'day_reconciled' AND as_of_date = $2::date LIMIT 1`, [parallelRunId, asOf])).length > 0; }
async function openDiffs(q: Queryable, parallelRunId: string): Promise<{ diff_id: string; loan_id: string | null; field: string; ours: string | null; theirs: string | null; as_of_date: string }[]> {
  const rows = await q.query<{ diff_id: string; loan_id: string | null; field: string; ours: string | null; theirs: string | null; as_of_date: string; action: string }>(`SELECT DISTINCT ON (diff_id) diff_id::text AS diff_id, loan_id::text AS loan_id, field, ours, theirs, as_of_date::text AS as_of_date, action FROM parallel_run_diffs WHERE parallel_run_id = $1 ORDER BY diff_id, created_at DESC, id DESC`, [parallelRunId]);
  return rows.filter((r) => r.action === "opened" || r.action === "reopened");
}
/** The incumbent file as a hashed document (a portal upload with the CSV text, or the id of one already stored — the SFTP path). */
async function fileDocument(d: PostureDeps, run: RunRow, asOf: string, i: ReconcileInput): Promise<{ id: string; csv: string }> {
  if (i.incumbent_file_document_id) {
    if (!isUuid(i.incumbent_file_document_id)) throw new RangeError("incumbent_file_document_id is a documents id");
    const [doc] = await d.db.query<{ id: string; kind: string; metadata: Row }>(`SELECT id::text AS id, kind, metadata FROM documents WHERE id = $1`, [i.incumbent_file_document_id]);
    if (!doc || doc.kind !== "incumbent_trial_balance") refuse(404, "FILE_NOT_FOUND", `no incumbent_trial_balance document ${i.incumbent_file_document_id}`, { document_id: i.incumbent_file_document_id });
    const csv = s(doc!.metadata["content"]); if (!csv) refuse(409, "FILE_EMPTY", `document ${doc!.id} carries no file content in the FAKE blob store`, { document_id: doc!.id });
    return { id: doc!.id, csv };
  }
  const csv = s(i.incumbent_file_csv); if (!csv.trim()) throw new RangeError("incumbent_file_document_id or incumbent_file_csv is required");
  const doc = hashedDocument("incumbent-trial-balance", { parallel_run_id: run.parallel_run_id, as_of_date: asOf, csv });
  d.deferWrite(async (q) => { await writeDocument(q, doc, { kind: "incumbent_trial_balance", retention: "corporate_7y", metadata: { parallel_run_id: run.parallel_run_id, as_of_date: asOf, incumbent_servicer: run.incumbent_servicer, content: csv, rows: csv.split(/\r?\n/).filter((l) => l.trim()).length - 1 }, created_at: d.now }); });
  return { id: doc.id, csv };
}
export async function reconcileDay(d: PostureDeps, i: ReconcileInput): Promise<ReconcileResult> {
  const run = await runState(d.db, s(i.parallel_run_id));
  if (!run || run.action === "closed") refuse(404, "RUN_NOT_OPEN", `no open parallel run ${s(i.parallel_run_id) || "(none)"}`, { parallel_run_id: i.parallel_run_id ?? null });
  const r = run!; await requireRoleOrService(d, RECONCILE_ROLES, "parallel_run.reconcile", r.environment);
  const asOf = s(i.as_of_date); if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new RangeError("as_of_date is YYYY-MM-DD");
  if (asOf < r.opened_on) throw new RangeError(`as_of_date ${asOf} precedes the run's opened_on ${r.opened_on}`);
  if (await dayReconciled(d.db, r.parallel_run_id, asOf)) refuse(409, "DAY_ALREADY_RECONCILED", `parallel run ${r.parallel_run_id} already reconciled ${asOf}; a second file for the day is refused (35.12 Integrations)`, { parallel_run_id: r.parallel_run_id, as_of_date: asOf });
  const file = await fileDocument(d, r, asOf, i);
  const theirs = parseIncumbentFile(file.csv);
  const ports = posturePortsOf(d.runtime);
  const ourLoans = await d.db.query<{ id: string; servicer_loan_number: string | null }>(`SELECT id::text AS id, servicer_loan_number FROM loans WHERE id = ANY($1::uuid[]) ORDER BY created_at, id`, [r.loan_ids]);
  const theirsByLoan = new Map<string, IncumbentRow>(); for (const t of theirs) { const key = t.loan_id ?? ourLoans.find((l) => l.servicer_loan_number === t.servicer_loan_number)?.id; if (key) theirsByLoan.set(key, t); }
  const open = await openDiffs(d.db, r.parallel_run_id);
  const now = d.now; const actor = d.actor; const by = personId(actor);
  let matched = 0; let mismatched = 0; let mismatchCents = 0n; let alreadyOpen = 0;
  const opened: (DiffOpened & { as_of_date: string })[] = []; const perLoan: Row[] = [];
  for (const l of ourLoans) {
    const ours = await ports.ourFigures.figures(d.db, l.id, asOf); const th = theirsByLoan.get(l.id);
    if (!ours || !th) { mismatched += RECONCILE_FIELDS.length; const ov = ours ? ours.upb_cents.toString() : "absent"; const tv = th ? th.upb_cents.toString() : "absent"; if (!open.some((o) => o.loan_id === l.id && o.field === "upb_cents" && o.ours === ov && o.theirs === tv)) opened.push({ diff_id: randomUUID(), loan_id: l.id, field: "upb_cents", ours: ov, theirs: tv, delta_cents: "0", as_of_date: asOf }); else alreadyOpen++; perLoan.push({ loan_id: l.id, absent: !th ? "theirs" : "ours" }); continue; }
    const row: Row = { loan_id: l.id, fields: {} };
    for (const f of RECONCILE_FIELDS) {
      const ov = fieldValue(ours, f); const tv = fieldValue(th, f); const eq = ov === tv;
      if (eq) matched++; else {
        mismatched++; const delta = MONEY_FIELDS.includes(f) ? BigInt(ov || "0") - BigInt(tv || "0") : 0n; mismatchCents += delta < 0n ? -delta : delta;
        if (open.some((o) => o.loan_id === l.id && o.field === f && o.ours === ov && o.theirs === tv)) alreadyOpen++; else opened.push({ diff_id: randomUUID(), loan_id: l.id, field: f, ours: ov, theirs: tv, delta_cents: delta.toString(), as_of_date: asOf });
      }
      (row["fields"] as Row)[f] = { ours: ov, theirs: tv, matched: eq };
    }
    perLoan.push(row);
  }
  for (const t of theirs) { const key = t.loan_id ?? ourLoans.find((l) => l.servicer_loan_number === t.servicer_loan_number)?.id; if (!key || !ourLoans.some((l) => l.id === key)) { mismatched += 1; if (!open.some((o) => o.loan_id === null && o.field === "upb_cents" && o.theirs === t.upb_cents.toString() && o.ours === "absent")) opened.push({ diff_id: randomUUID(), loan_id: "", field: "upb_cents", ours: "absent", theirs: t.upb_cents.toString(), delta_cents: "0", as_of_date: asOf }); else alreadyOpen++; } }
  const comparisons = ourLoans.length * RECONCILE_FIELDS.length;
  const report = hashedDocument("parallel-run-day", { parallel_run_id: r.parallel_run_id, environment: r.environment, as_of_date: asOf, incumbent_file_document_id: file.id, loans: ourLoans.length, comparisons, matched, mismatched, mismatch_cents: mismatchCents.toString(), diffs_opened: opened.map((o) => ({ diff_id: o.diff_id, loan_id: o.loan_id || null, field: o.field, ours: o.ours, theirs: o.theirs, delta_cents: o.delta_cents })), per_loan: perLoan });
  d.deferWrite(async (q) => {
    await writeDocument(q, report, { kind: "parallel_run_daily_report", retention: "corporate_7y", metadata: { parallel_run_id: r.parallel_run_id, as_of_date: asOf, comparisons, matched, mismatched, mismatch_cents: mismatchCents.toString() }, created_at: now });
    const decision_id = await decisionFor(q, "parallel_run", r.parallel_run_id);
    await q.query(`INSERT INTO parallel_runs (parallel_run_id, environment, incumbent_servicer, opened_on, planned_end_on, loan_count, action, as_of_date, comparisons, matched, mismatched, mismatch_cents, incumbent_file_document_id, report_document_id, by, decision_id, loan_ids, created_at) VALUES ($1, $2, $3, $4::date, $5::date, $6, 'day_reconciled', $7::date, $8, $9, $10, $11, $12, $13, $14, $15, $16::uuid[], $17::timestamptz)`,
      [r.parallel_run_id, r.environment, r.incumbent_servicer, r.opened_on, r.planned_end_on, r.loan_count, asOf, comparisons, matched, mismatched, mismatchCents, file.id, report.id, by, decision_id, r.loan_ids, now]);
    for (const o of opened) await q.query(`INSERT INTO parallel_run_diffs (diff_id, parallel_run_id, as_of_date, loan_id, field, ours, theirs, delta_cents, action, by, decision_id, created_at) VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, 'opened', $9, $10, $11::timestamptz)`, [o.diff_id, r.parallel_run_id, asOf, o.loan_id || null, o.field, o.ours, o.theirs, o.delta_cents, by, decision_id, now]);
  });
  d.events.append({ type: "parallel_run.day.reconciled", aggregate: runAggregate(r.parallel_run_id), actor, payload: P({ parallel_run_id: r.parallel_run_id, environment: r.environment, as_of_date: asOf, loans: ourLoans.length, comparisons, matched, mismatched, mismatch_cents: mismatchCents.toString(), diffs_opened: opened.length, incumbent_file_document_id: file.id, report_document_id: report.id, sha256: report.sha256, by: byOf(actor) }) });
  return { parallel_run_id: r.parallel_run_id, environment: r.environment, as_of_date: asOf, loans: ourLoans.length, comparisons, matched, mismatched, mismatch_cents: mismatchCents.toString(), diffs_opened: opened.map(({ diff_id, loan_id, field, ours, theirs, delta_cents }) => ({ diff_id, loan_id, field, ours, theirs, delta_cents })), diffs_already_open: alreadyOpen, incumbent_file_document_id: file.id, report_document_id: report.id, by: byOf(actor) };
}
/** The open runs of the environment whose file for the day arrived as a document and whose day is not reconciled (the 21:00 ET cycle). */
export async function pendingReconciliations(q: Queryable, environment: string, asOf: string): Promise<{ parallel_run_id: string; as_of_date: string; document_id: string }[]> {
  const run = await openRunOf(q, environment); if (!run) return [];
  if (await dayReconciled(q, run.parallel_run_id, asOf)) return [];
  const [doc] = await q.query<{ id: string }>(`SELECT id::text AS id FROM documents WHERE kind = 'incumbent_trial_balance' AND metadata->>'parallel_run_id' = $1 AND metadata->>'as_of_date' = $2 ORDER BY created_at DESC LIMIT 1`, [run.parallel_run_id, asOf]);
  return doc ? [{ parallel_run_id: run.parallel_run_id, as_of_date: asOf, document_id: doc.id }] : [];
}

// ---- dispositions --------------------------------------------------------------------------------------------------
export interface DispositionInput { readonly op?: string | null; readonly parallel_run_id?: string | null; readonly diff_id: string; readonly disposition?: string | null; readonly reason?: string | null; readonly confidence?: number | null; readonly rationale?: string | null }
export interface DispositionResult { readonly diff_id: string; readonly parallel_run_id: string; readonly environment: string; readonly loan_id: string | null; readonly field: string; readonly disposition: string; readonly proposed: boolean; readonly confidence: number | null; readonly reason: string; readonly by: string }
export async function dispositionDiff(d: PostureDeps, i: DispositionInput): Promise<DispositionResult> {
  const [diff] = await d.db.query<{ diff_id: string; parallel_run_id: string; loan_id: string | null; field: string; ours: string | null; theirs: string | null; action: string; environment: string }>(`SELECT x.diff_id::text AS diff_id, x.parallel_run_id::text AS parallel_run_id, x.loan_id::text AS loan_id, x.field, x.ours, x.theirs, x.action, r.environment FROM (SELECT DISTINCT ON (diff_id) * FROM parallel_run_diffs WHERE diff_id = $1 ORDER BY diff_id, created_at DESC, id DESC) x JOIN (SELECT DISTINCT ON (parallel_run_id) parallel_run_id, environment FROM parallel_runs ORDER BY parallel_run_id, created_at DESC) r ON r.parallel_run_id = x.parallel_run_id`, [isUuid(i.diff_id) ? i.diff_id : "00000000-0000-0000-0000-000000000000"]);
  if (!diff) refuse(404, "DIFF_NOT_FOUND", `no parallel-run diff ${s(i.diff_id) || "(none)"}`, { diff_id: i.diff_id ?? null });
  const x = diff!; const disposition = s(i.disposition);
  if (!DISPOSITIONS.includes(disposition)) throw new RangeError(`disposition ∈ {${DISPOSITIONS.join(", ")}}`);
  const op = s(i.op) || (d.actor.kind === "agent" ? "propose" : "disposition");
  if (op === "propose") {
    // the agent's proposal: a decision record (the tool's) with the confidence and the rationale; no diff row changes
    if (d.actor.kind === "human") await requireRole(d, ["officer"], "parallel_run.disposition:propose", x.environment);
    const confidence = typeof i.confidence === "number" ? i.confidence : null;
    return { diff_id: x.diff_id, parallel_run_id: x.parallel_run_id, environment: x.environment, loan_id: x.loan_id, field: x.field, disposition, proposed: true, confidence, reason: s(i.rationale) || s(i.reason) || "(no rationale)", by: byOf(d.actor) };
  }
  const officer = await requireRole(d, ["officer"], "parallel_run.disposition", x.environment);
  if (x.action !== "opened" && x.action !== "reopened") refuse(409, "DIFF_NOT_OPEN", `diff ${x.diff_id} is ${x.action}`, { diff_id: x.diff_id, action: x.action });
  const reason = s(i.reason).trim(); if (!reason) throw new RangeError("a disposition needs a reason (35.12 rule 8)");
  const now = d.now; const by = personId(d.actor);
  d.deferWrite(async (q) => { const decision_id = await decisionFor(q, "diff", x.diff_id); await q.query(`INSERT INTO parallel_run_diffs (diff_id, parallel_run_id, as_of_date, loan_id, field, ours, theirs, delta_cents, action, disposition, reason, by, decision_id, created_at) SELECT diff_id, parallel_run_id, as_of_date, loan_id, field, ours, theirs, delta_cents, 'dispositioned', $2, $3, $4, $5, $6::timestamptz FROM parallel_run_diffs WHERE diff_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [x.diff_id, disposition, reason, by, decision_id, now]); });
  d.events.append({ type: "parallel_run.diff.dispositioned", aggregate: { kind: "parallel_run_diff", id: x.diff_id }, actor: d.actor, ...(x.loan_id ? { loanId: x.loan_id } : {}), payload: P({ diff_id: x.diff_id, parallel_run_id: x.parallel_run_id, loan_id: x.loan_id, field: x.field, disposition, reason, by: officer.id }) });
  return { diff_id: x.diff_id, parallel_run_id: x.parallel_run_id, environment: x.environment, loan_id: x.loan_id, field: x.field, disposition, proposed: false, confidence: null, reason, by: byOf(d.actor) };
}

// ---- the close and the board ---------------------------------------------------------------------------------------
/** The clean-week count as of `asOf`: consecutive reconciled days ending at asOf with no money-field diff opened that day (a missing day breaks the run). */
export async function daysClean(q: Queryable, parallelRunId: string, asOf: string): Promise<number> {
  const days = new Set((await q.query<{ d: string }>(`SELECT as_of_date::text AS d FROM parallel_runs WHERE parallel_run_id = $1 AND action = 'day_reconciled'`, [parallelRunId])).map((r) => r.d));
  const dirty = new Set((await q.query<{ d: string }>(`SELECT DISTINCT as_of_date::text AS d FROM parallel_run_diffs WHERE parallel_run_id = $1 AND action = 'opened' AND field = ANY($2::text[])`, [parallelRunId, MONEY_FIELDS])).map((r) => r.d));
  let n = 0; let day = asOf;
  while (days.has(day) && !dirty.has(day)) { n++; day = addCalendarDays(day, -1); }
  return n;
}
export interface CloseInput { readonly parallel_run_id: string; readonly outcome?: string | null; readonly reason?: string | null }
export interface CloseResult { readonly parallel_run_id: string; readonly environment: string; readonly outcome: "passed" | "abandoned"; readonly closed_on: string; readonly days: number; readonly days_clean: number; readonly open_diffs: number; readonly final_week_mismatched: number; readonly by: string }
export async function closeRun(d: PostureDeps, i: CloseInput): Promise<CloseResult> {
  const run = await runState(d.db, s(i.parallel_run_id));
  if (!run || run.action === "closed") refuse(404, "RUN_NOT_OPEN", `no open parallel run ${s(i.parallel_run_id) || "(none)"}`, { parallel_run_id: i.parallel_run_id ?? null });
  const r = run!; const officer = await requireRole(d, ["officer"], "parallel_run.close", r.environment);
  const outcome = s(i.outcome); if (outcome !== "passed" && outcome !== "abandoned") throw new RangeError("outcome ∈ {passed, abandoned}");
  const now = d.now; const closed_on = wallClock(Date.parse(now), ET).date; const by = personId(d.actor);
  const days = daysBetween(r.opened_on, closed_on); const open = (await openDiffs(d.db, r.parallel_run_id)).length; const clean = await daysClean(d.db, r.parallel_run_id, closed_on);
  const [wk] = await d.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM parallel_run_diffs WHERE parallel_run_id = $1 AND action = 'opened' AND field = ANY($2::text[]) AND as_of_date > ($3::date - 7)`, [r.parallel_run_id, MONEY_FIELDS, closed_on]);
  const reason = s(i.reason).trim();
  if (outcome === "abandoned") { if (!reason) throw new RangeError("an abandoned close needs a reason (35.12 rule 9)"); }
  else {
    if (days < PARALLEL_RUN_DAYS) refuse(409, "PARALLEL_RUN_TOO_SHORT", `the run opened ${r.opened_on} has run ${days} days on ${closed_on}; 28 consecutive calendar days are the minimum (35.12 rule 9)`, { parallel_run_id: r.parallel_run_id, days, opened_on: r.opened_on, closed_on });
    if (open > 0) refuse(409, "PARALLEL_RUN_OPEN_DIFFS", `${open} diff(s) are open; every diff is dispositioned before the close (35.12 rule 9)`, { parallel_run_id: r.parallel_run_id, count: open });
    if (clean < CLEAN_WEEK_DAYS) refuse(409, "PARALLEL_RUN_DIRTY_WEEK", `the last ${CLEAN_WEEK_DAYS} reconciled days must show no money mismatch and no missing day; ${clean} clean day(s) as of ${closed_on} (35.12 rule 9)`, { parallel_run_id: r.parallel_run_id, days_clean: clean });
  }
  d.deferWrite(async (q) => { const decision_id = await decisionFor(q, "parallel_run", r.parallel_run_id); await q.query(`INSERT INTO parallel_runs (parallel_run_id, environment, incumbent_servicer, opened_on, planned_end_on, loan_count, action, as_of_date, outcome, reason, by, decision_id, loan_ids, created_at) VALUES ($1, $2, $3, $4::date, $5::date, $6, 'closed', $7::date, $8, $9, $10, $11, $12::uuid[], $13::timestamptz)`, [r.parallel_run_id, r.environment, r.incumbent_servicer, r.opened_on, r.planned_end_on, r.loan_count, closed_on, outcome, reason || null, by, decision_id, r.loan_ids, now]); });
  if (outcome === "abandoned") cancelGate(d, `parallel run ${r.parallel_run_id} abandoned: ${reason} (35.12 rule 9)`);
  d.events.append({ type: "parallel_run.closed", aggregate: runAggregate(r.parallel_run_id), actor: d.actor, payload: P({ parallel_run_id: r.parallel_run_id, environment: r.environment, closed_on, outcome, days, days_clean: clean, final_week_mismatched: Number(wk!.n), reason: reason || null, by: officer.id }) });
  return { parallel_run_id: r.parallel_run_id, environment: r.environment, outcome, closed_on, days, days_clean: clean, open_diffs: open, final_week_mismatched: Number(wk!.n), by: byOf(d.actor) };
}
/** The parallel-run board (Reports): days, matched/mismatched, open diffs by field, the clean-week count as of today, the gate's day, the extensions. */
export async function parallelRunBoard(q: Queryable, parallelRunId: string, nowIso: string): Promise<Row> {
  const run = await runState(q, parallelRunId); if (!run) return { parallel_run_id: parallelRunId, found: false };
  const asOf = wallClock(Date.parse(nowIso), ET).date;
  const days = await q.query<Row>(`SELECT as_of_date::text AS as_of_date, comparisons, matched, mismatched, mismatch_cents::text AS mismatch_cents, report_document_id::text AS report_document_id FROM parallel_runs WHERE parallel_run_id = $1 AND action = 'day_reconciled' ORDER BY as_of_date`, [parallelRunId]);
  const open = await openDiffs(q, parallelRunId); const byField: Record<string, number> = {}; for (const o of open) byField[o.field] = (byField[o.field] ?? 0) + 1;
  const ext = await q.query<Row>(`SELECT planned_end_on::text AS planned_end_on, reason, created_at::text AS created_at FROM parallel_runs WHERE parallel_run_id = $1 AND action = 'extended' ORDER BY created_at`, [parallelRunId]);
  return { parallel_run_id: parallelRunId, found: true, environment: run.environment, status: run.action === "closed" ? `closed:${run.outcome}` : "open", opened_on: run.opened_on, planned_end_on: run.planned_end_on, gate_not_before: run.planned_end_on, loan_count: run.loan_count, as_of: asOf, days_reconciled: days.length, days, open_diffs: open.length, open_diffs_by_field: byField, days_clean: await daysClean(q, parallelRunId, asOf), extensions: ext };
}
export const diffsOf = openDiffs;
export const runRowsOf = (q: Queryable, id: string): Promise<Row[]> => q.query<Row>(`SELECT action, as_of_date::text AS as_of_date, outcome, comparisons, matched, mismatched, mismatch_cents::text AS mismatch_cents FROM parallel_runs WHERE parallel_run_id = $1 ORDER BY created_at, id`, [id]);
void obj;
