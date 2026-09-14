/**
 * §34.3 rule 6 — "The daily report per partner" (33.2 Outputs: the examiner's daily report per partner — reviewed, candidates,
 * watching, not now, excluded, offers delivered, expired, analyst turns and skips, the fair-lending extract id; 33.3 Outputs:
 * checked, ready, not ready by missing item, applications opened, DU runs reached).
 *
 *   bookDailyReport    produces the `partner_book_daily_reports` row for a partner and day from the day's
 *                      `partner_book.review.run_completed` payload (the partner's program's), the `partner_book.readiness.run_completed`
 *                      payload (its `loans` narrowed to the partner's), 20.1's `refi_trigger_runs` / `fair_lending_extracts` entities of
 *                      the day and the book summary (loans monitored, on hold, paid off, transferred out, `last_as_of_date`,
 *                      `next_expected` = last as-of + 7 days) — with the decision record {partner_party_id, as_of_date, counts,
 *                      fair_lending_extract_id, rule_set_version partner_book.report.v1, model_version deterministic, prompt_version
 *                      34.3-v1, confidence 1}. Idempotent per partner-day: the newest row wins and a re-run that would say the same
 *                      thing appends nothing (the sweep calls this every pass); a re-run that says something new (a receipt that
 *                      arrived since) appends the newer row (state machine: `produced`, append-only). A missing receipt is marked
 *                      `absent: true` and its counts come from the rows (edge cases: "the daily report is produced with readiness
 *                      marked absent").
 *   exportDailyReport  `compliance` exports the newest row as a document with a hash: a `documents` row (kind
 *                      partner_book_daily_report, sha256 of the JSON text) and a newer report row carrying `document_id` (rows are
 *                      never updated). Idempotent: the same content already exported returns the same document.
 *
 * Rule 7: every figure here is a receipt's count, a row count, or a stored engine id; nothing is computed about a loan.
 */
import { toJson, type Queryable } from "../../infra/db/client.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { addDays, plainDate, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Runtime } from "../app.ts";
import { type Row, PORTFOLIO_AGENT, TAPE_EXPECTED_DAYS, dayBounds, holdsOf, isDate, isUuid, newestId, num, str } from "./common.ts";
import { sha256Hex } from "../../domain/partner-book/import.ts";

export const REPORT_RULE_SET_VERSION = "partner_book.report.v1";
export const REPORT_MODEL_VERSION = "deterministic";
export const REPORT_PROMPT_VERSION = "34.3-v1";
export const REPORT_DOCUMENT_KIND = "partner_book_daily_report";

export type ReviewSummary = { absent: boolean; source: "receipt" | "rows"; run_id: string | null; program_id: string | null; refi_run_id: string | null; at: string | null; reviewed: number; candidates: number; watching: number; not_now: number; excluded: number; offers_delivered: number; offers_portal_only: number; expired: number; analyst_turns: number; analyst_skipped: number; analyst_skipped_by_reason: Record<string, number>; fair_lending_extract_id: string | null };
export type ReadinessSummary = { absent: boolean; source: "receipt" | "rows"; run_id: string | null; at: string | null; checked: number; ready: number; not_ready: number; not_ready_by_item: Record<string, number>; applications_opened: number; du_runs: number };
export type BookSummary = { loans_monitored: number; on_hold: number; paid_off: number; transferred_out: number; last_as_of_date: string | null; next_expected: string | null; imports: number };
export type DailyReportRow = { id: string; partner_party_id: string; partner_legal_name: string | null; as_of_date: string; review: ReviewSummary; readiness: ReadinessSummary; book: BookSummary; produced_by: string; document_id: string | null; created_at: string; decision_id: string | null };
export type DailyReportResult = { report: DailyReportRow; produced: boolean };

const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.map(obj) : []);
const counts = (v: unknown): Record<string, number> => { const out: Record<string, number> = {}; for (const [k, x] of Object.entries(obj(v))) out[k] = num(x); return out; };
const ROW_COLS = `r.id::text AS id, r.partner_party_id::text AS partner_party_id, pp.legal_name AS partner_legal_name, r.as_of_date::text AS as_of_date, r.review, r.readiness, r.book, r.produced_by, r.document_id::text AS document_id, r.created_at::text AS created_at`;
type DbRow = { id: string; partner_party_id: string; partner_legal_name: string | null; as_of_date: string; review: ReviewSummary; readiness: ReadinessSummary; book: BookSummary; produced_by: string; document_id: string | null; created_at: string };
const decisionOf = async (db: Queryable, reportId: string): Promise<string | null> => (await db.query<{ id: string }>(`SELECT id::text AS id FROM agent_decisions WHERE subject_kind = 'partner_book_daily_report' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1`, [reportId]).catch(() => [] as { id: string }[]))[0]?.id ?? null;
const toRow = async (db: Queryable, r: DbRow): Promise<DailyReportRow> => ({ ...r, decision_id: await decisionOf(db, r.id) });

/** The newest row per partner-day (state machine: newest wins). */
export async function latestDailyReport(rt: Runtime, partnerId: string, asOf: string): Promise<DailyReportRow | null> {
  if (!isUuid(partnerId) || !isDate(asOf)) return null;
  const r = (await rt.db.query<DbRow>(`SELECT ${ROW_COLS} FROM partner_book_daily_reports r JOIN parties pp ON pp.id = r.partner_party_id WHERE r.partner_party_id = $1 AND r.as_of_date = $2 ORDER BY r.created_at DESC, r.id DESC LIMIT 1`, [partnerId, asOf]))[0];
  return r ? toRow(rt.db, r) : null;
}
/** Every row of a partner (newest first) — the examiner's list. */
export async function listDailyReports(rt: Runtime, partnerId?: string | null, limit = 200): Promise<DailyReportRow[]> {
  const rs = await rt.db.query<DbRow>(`SELECT ${ROW_COLS} FROM partner_book_daily_reports r JOIN parties pp ON pp.id = r.partner_party_id WHERE ($1::uuid IS NULL OR r.partner_party_id = $1::uuid) ORDER BY r.as_of_date DESC, r.created_at DESC LIMIT $2`, [isUuid(partnerId) ? partnerId : null, Math.min(Math.max(limit, 1), 1000)]);
  const out: DailyReportRow[] = []; for (const r of rs) out.push(await toRow(rt.db, r)); return out;
}

// ---------------------------------------------------------------- the three summaries, from receipts and rows
async function reviewSummary(db: Queryable, partnerId: string, asOf: PlainDate): Promise<ReviewSummary> {
  const receipt = (await db.query<{ payload: Row; occurred_at: string }>(`SELECT payload, occurred_at::text AS occurred_at FROM loan_events WHERE type = 'partner_book.review.run_completed' AND payload->>'as_of_date' = $1 AND payload->>'partner_id' = $2 ORDER BY sequence DESC LIMIT 1`, [asOf, partnerId]))[0] ?? null;
  const program = receipt ? str(receipt.payload["program_id"]) : (await db.query<{ id: string }>(`SELECT id FROM entity_current WHERE kind = 'partner_programs' AND data->>'partner_id' = $1 ORDER BY id LIMIT 1`, [partnerId]))[0]?.id ?? null;
  // 20.1's rows of the day: the run (its fair_lending_extract_document_id) and, failing that, the extract itself (`fle-<program>-<as_of>`)
  let extract: string | null = null; let refiRun: string | null = null;
  if (program) {
    const run = (await db.query<{ id: string; data: unknown }>(`SELECT id, data FROM entity_current WHERE kind = 'refi_trigger_runs' AND data->>'program_id' = $1 AND data->>'as_of_date' = $2 ORDER BY id DESC LIMIT 1`, [program, asOf]))[0];
    if (run) { refiRun = run.id; extract = str(decodeEntityData(run.data)["fair_lending_extract_document_id"]); }
    if (!extract) extract = (await db.query<{ id: string }>(`SELECT id FROM entity_current WHERE kind = 'fair_lending_extracts' AND data->>'program_id' = $1 AND data->>'as_of_date' = $2 ORDER BY id LIMIT 1`, [program, asOf]))[0]?.id ?? null;
  }
  if (receipt) {
    const p = receipt.payload;
    return { absent: false, source: "receipt", run_id: str(p["run_id"]), program_id: program, refi_run_id: refiRun, at: str(p["at"]) ?? new Date(receipt.occurred_at).toISOString(), reviewed: num(p["reviewed"]), candidates: num(p["candidates"]), watching: num(p["watching"]), not_now: num(p["not_now"]), excluded: num(p["excluded"]),
      offers_delivered: num(p["offers_delivered"]), offers_portal_only: num(p["offers_portal_only"]), expired: num(p["expired"]), analyst_turns: num(p["analyst_turns"]), analyst_skipped: num(p["analyst_skipped"]), analyst_skipped_by_reason: counts(p["analyst_skipped_by_reason"]), fair_lending_extract_id: extract };
  }
  // no receipt: the rows of the day (a count of rows), marked absent
  const rs = await db.query<{ verdict: string; analyst: Row }>(`SELECT r.verdict, r.analyst FROM partner_book_reviews r JOIN loans l ON l.id = r.loan_id WHERE r.as_of_date = $1 AND l.partner_party_id = $2`, [asOf, partnerId]);
  const by: Record<string, number> = {}; const skipped: Record<string, number> = {}; let turns = 0;
  for (const r of rs) { by[r.verdict] = (by[r.verdict] ?? 0) + 1; const s = str(obj(r.analyst)["skipped"]); if (s) skipped[s] = (skipped[s] ?? 0) + 1; if (str(obj(r.analyst)["turn_id"])) turns += 1; }
  return { absent: true, source: "rows", run_id: null, program_id: program, refi_run_id: refiRun, at: null, reviewed: rs.length, candidates: by["candidate"] ?? 0, watching: by["watching"] ?? 0, not_now: by["not_now"] ?? 0, excluded: by["excluded"] ?? 0, offers_delivered: 0, offers_portal_only: 0, expired: 0, analyst_turns: turns, analyst_skipped: Object.values(skipped).reduce((a, b) => a + b, 0), analyst_skipped_by_reason: skipped, fair_lending_extract_id: extract };
}

async function readinessSummary(db: Queryable, partnerId: string, asOf: PlainDate): Promise<ReadinessSummary> {
  const loans = (await db.query<{ id: string }>(`SELECT l.id::text AS id FROM loans l WHERE l.partner_party_id = $1 AND EXISTS (SELECT 1 FROM partner_book_facts f WHERE f.loan_id = l.id)`, [partnerId])).map((l) => l.id);
  const mine = new Set(loans);
  const { start, end } = dayBounds(asOf);
  const [opened, du] = await Promise.all([
    db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events e WHERE e.type = 'partner_book.refinance.opened' AND e.loan_id = ANY($1::uuid[]) AND e.occurred_at >= $2::timestamptz AND e.occurred_at < $3::timestamptz`, [loans, start, end]),
    db.query<{ n: string }>(`SELECT count(*)::text AS n FROM du_casefiles d JOIN applications a ON a.id = d.application_id WHERE a.prior_loan_id = ANY($1::uuid[]) AND d.created_at >= $2::timestamptz AND d.created_at < $3::timestamptz`, [loans, start, end]),
  ]);
  const applications_opened = Number(opened[0]?.n ?? 0), du_runs = Number(du[0]?.n ?? 0);
  const receipt = (await db.query<{ payload: Row; occurred_at: string }>(`SELECT payload, occurred_at::text AS occurred_at FROM loan_events WHERE type = 'partner_book.readiness.run_completed' AND payload->>'as_of_date' = $1 ORDER BY sequence DESC LIMIT 1`, [asOf]))[0] ?? null;
  if (receipt) {
    const p = receipt.payload; const checked = rows(p["loans"]).filter((l) => mine.has(String(l["loan_id"] ?? "")));
    const byItem: Record<string, number> = {}; let ready = 0;
    for (const l of checked) { if (l["ready"] === true) ready += 1; for (const m of (Array.isArray(l["missing"]) ? l["missing"] : []).map(String)) byItem[m] = (byItem[m] ?? 0) + 1; }
    return { absent: false, source: "receipt", run_id: str(p["run_id"]), at: str(p["at"]) ?? new Date(receipt.occurred_at).toISOString(), checked: checked.length, ready, not_ready: checked.length - ready, not_ready_by_item: byItem, applications_opened, du_runs };
  }
  const rs = await db.query<{ ready: boolean; missing: unknown }>(`SELECT k.ready, k.missing FROM readiness_checks k WHERE k.as_of_date = $1 AND k.loan_id = ANY($2::uuid[])`, [asOf, loans]);
  const byItem: Record<string, number> = {}; let ready = 0;
  for (const r of rs) { if (r.ready) ready += 1; for (const m of (Array.isArray(r.missing) ? r.missing : []).map(String)) byItem[m] = (byItem[m] ?? 0) + 1; }
  return { absent: true, source: "rows", run_id: null, at: null, checked: rs.length, ready, not_ready: rs.length - ready, not_ready_by_item: byItem, applications_opened, du_runs };
}

async function bookSummary(rt: Runtime, partnerId: string, now: string): Promise<BookSummary> {
  const [st, imp, holds] = await Promise.all([
    rt.db.query<{ status: string; n: string }>(`SELECT l.status::text AS status, count(*)::text AS n FROM loans l WHERE l.partner_party_id = $1 AND EXISTS (SELECT 1 FROM partner_book_facts f WHERE f.loan_id = l.id) GROUP BY l.status`, [partnerId]),
    rt.db.query<{ last: string | null; n: string }>(`SELECT max(as_of_date)::text AS last, count(*)::text AS n FROM partner_book_imports WHERE partner_party_id = $1 AND status = 'loaded'`, [partnerId]),
    holdsOf(rt, partnerId, now)]);
  const by = Object.fromEntries(st.map((s) => [s.status, Number(s.n)]));
  const last = imp[0]?.last ?? null;
  return { loans_monitored: by["monitored"] ?? 0, on_hold: holds.length, paid_off: by["paid_off"] ?? 0, transferred_out: by["transferred_out"] ?? 0, last_as_of_date: last, next_expected: last ? addDays(plainDate(last), TAPE_EXPECTED_DAYS) : null, imports: Number(imp[0]?.n ?? 0) };
}
/** Canonical JSON (keys sorted at every level): jsonb hands object keys back in its own order, so equality is judged on content, not key order. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const sameContent = (a: { review: unknown; readiness: unknown; book: unknown }, b: { review: unknown; readiness: unknown; book: unknown }): boolean => canonical(a.review) === canonical(b.review) && canonical(a.readiness) === canonical(b.readiness) && canonical(a.book) === canonical(b.book);

/** Rule 6 / AI agent design: the row and its decision, idempotent per partner-day (newest wins; nothing appended when nothing changed). */
export async function bookDailyReport(rt: Runtime, i: { readonly partner: string; readonly as_of: string; readonly produced_by?: string }, actor: Actor = PORTFOLIO_AGENT): Promise<DailyReportResult> {
  if (!isUuid(i.partner)) throw new RangeError("partner is a uuid");
  if (!isDate(i.as_of)) throw new RangeError("as_of is a date (YYYY-MM-DD)");
  const partner = (await rt.db.query<{ id: string; legal_name: string }>(`SELECT id::text AS id, legal_name FROM parties WHERE id = $1 AND party_type = 'servicer'`, [i.partner]))[0];
  if (!partner) throw new RangeError(`no partner ${i.partner}`);
  const asOf = plainDate(i.as_of); const now = rt.clock.now();
  const [review, readiness, book] = await Promise.all([reviewSummary(rt.db, partner.id, asOf), readinessSummary(rt.db, partner.id, asOf), bookSummary(rt, partner.id, now)]);
  const latest = await latestDailyReport(rt, partner.id, asOf);
  if (latest && sameContent(latest, { review, readiness, book })) return { report: latest, produced: false };
  const id = newestId(); const produced_by = i.produced_by ?? `${actor.kind}:${actor.id}`;   // time-ordered: the newest row per partner-day wins
  const countsLine = `reviewed ${review.reviewed} (candidates ${review.candidates}, watching ${review.watching}, not_now ${review.not_now}, excluded ${review.excluded}; offers ${review.offers_delivered}, expired ${review.expired}, analyst turns ${review.analyst_turns}, skipped ${review.analyst_skipped}${review.absent ? "; review receipt absent" : ""}); readiness checked ${readiness.checked} (ready ${readiness.ready}, not ready ${readiness.not_ready}${readiness.absent ? "; readiness receipt absent" : ""}); book monitored ${book.loans_monitored}, on hold ${book.on_hold}, paid off ${book.paid_off}, transferred out ${book.transferred_out}, last as-of ${book.last_as_of_date ?? "none"}, next expected ${book.next_expected ?? "none"}`;
  const r = await rt.uow.run({}, async (ctx) => {
    ctx.decide({ agent: PORTFOLIO_AGENT.id, action: "book.daily_report", ruleSetVersion: REPORT_RULE_SET_VERSION, modelVersion: REPORT_MODEL_VERSION, promptVersion: REPORT_PROMPT_VERSION, confidence: 1, subject: { kind: "partner_book_daily_report", id }, ruleCode: "34.3 rule 6",
      rationale: `daily report for partner ${partner.id} as of ${asOf} (${produced_by}): ${countsLine}; fair-lending extract ${review.fair_lending_extract_id ?? "none"}` });
  }, { clock: rt.clock, commit: async (q) => {
    await q.query(`INSERT INTO partner_book_daily_reports (id, partner_party_id, as_of_date, review, readiness, book, produced_by, document_id, created_at) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, NULL, $8)`, [id, partner.id, asOf, toJson(review), toJson(readiness), toJson(book), produced_by, now]);
  } });
  rt.logger?.info("partner book daily report produced", { report_id: id, partner_party_id: partner.id, as_of_date: asOf, produced_by, counts: countsLine, fair_lending_extract_id: review.fair_lending_extract_id, superseded: latest?.id ?? null });
  return { report: { id, partner_party_id: partner.id, partner_legal_name: partner.legal_name, as_of_date: asOf, review, readiness, book, produced_by, document_id: null, created_at: now, decision_id: r.decisions[0]?.id ?? null }, produced: true };
}

/** The document text: the report's substance as JSON (what the hash covers) — the partner, the day, the three summaries and the rule set; never a row id or an instant, so every appended copy of the same content hashes the same (the row id and the export instant are the documents row's metadata). */
export const renderDailyReport = (r: DailyReportRow): string => toJson({ kind: REPORT_DOCUMENT_KIND, partner_party_id: r.partner_party_id, partner_legal_name: r.partner_legal_name, as_of_date: r.as_of_date, produced_by: r.produced_by, review: r.review, readiness: r.readiness, book: r.book, rule_set_version: REPORT_RULE_SET_VERSION });

export type DailyReportExport = { document_id: string; sha256: string; byte_size: number; content: string; report: DailyReportRow; created: boolean };
/** Rule 6: exportable by `compliance` as a document with a hash — the documents row and the newer report row carrying `document_id`. */
export async function exportDailyReport(rt: Runtime, i: { readonly partner: string; readonly as_of: string }, actor: Actor): Promise<DailyReportExport> {
  const { report } = await bookDailyReport(rt, i, actor);   // the newest content (produced on demand when the sweep has not)
  const content = renderDailyReport(report); const sha = sha256Hex(content); const size = Buffer.byteLength(content, "utf8");
  // idempotent: a document with this very hash already exported for the partner-day is the export (the row carrying it may not be the newest — a later re-run appended the same content again)
  const doc = (await rt.db.query<{ id: string; sha256: string }>(`SELECT d.id::text AS id, d.sha256 FROM documents d JOIN partner_book_daily_reports r ON r.document_id = d.id WHERE r.partner_party_id = $1 AND r.as_of_date = $2 AND d.sha256 = $3 ORDER BY r.created_at DESC, r.id DESC LIMIT 1`, [report.partner_party_id, report.as_of_date, sha]))[0];
  if (doc) return { document_id: doc.id, sha256: sha, byte_size: size, content, report: { ...report, document_id: doc.id }, created: false };
  const document_id = newestId(); const id = newestId(); const now = rt.clock.now();
  await rt.db.tx(async (q) => {
    await q.query(`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata, created_at) VALUES ($1, $2, $3, $4, $5, 'application/json', 'corporate_7y', $6::jsonb, $7)`,
      [document_id, REPORT_DOCUMENT_KIND, sha, size, `report://partner-book/${report.partner_party_id}/${report.as_of_date}/${report.id}`, toJson({ report_id: report.id, partner_party_id: report.partner_party_id, as_of_date: report.as_of_date, exported_by: `${actor.kind}:${actor.id}`, exported_role: actor.role ?? null, rule_set_version: REPORT_RULE_SET_VERSION }), now]);
    // newest wins: the export is a newer row with the same content and the document id (append-only — never an UPDATE)
    await q.query(`INSERT INTO partner_book_daily_reports (id, partner_party_id, as_of_date, review, readiness, book, produced_by, document_id, created_at) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9)`, [id, report.partner_party_id, report.as_of_date, toJson(report.review), toJson(report.readiness), toJson(report.book), report.produced_by, document_id, now]);
  });
  rt.logger?.info("partner book daily report exported", { report_id: id, superseded: report.id, partner_party_id: report.partner_party_id, as_of_date: report.as_of_date, document_id, sha256: sha, byte_size: size, by: `${actor.kind}:${actor.id}` });
  return { document_id, sha256: sha, byte_size: size, content, report: { ...report, id, document_id, created_at: now }, created: true };
}
