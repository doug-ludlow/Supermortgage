/**
 * 36.2 — the partner tape drop on `book.import`, the import history, the status line and the holds
 * (spec/sections/36-servicing-partner-portal/36-2-partner-tape-drop-on-book-import.md). A wrapper over 33.1's runtime seam
 * (src/runtime/partner-book.ts) and 34.3's read tools (src/runtime/book-ops/), called by ./routes.ts; nothing of the book is
 * parsed, planned, written or computed here (rules 1, 5, 12).
 *
 *   partnerImportInputOf   the multipart or JSON body → `as_of_date`, `tape`, `supplement` — and nothing else (rule 2: a `partner`,
 *                          `partner_party_id`, `nmlsr_id` or `profile` field is dropped before the parse, neither honoured nor an error).
 *   tenantPartner          the import's `partner` from the session's tenant: the parties{servicer} row's legal name, servicer number and
 *                          MERS org id, the NMLSR id from the `partners/<id>` entity 33.1's planPartner keeps (else the row's contact).
 *   partnerImport          33.1's importPartnerBook with `{partner: the tenant, as_of_date, profile: "m3-v1", tape, supplement}` and the
 *                          partner user as actor (rule 1); the answer is the report partnerBookReport returns (rule 5), idempotent as
 *                          33.1 is (rule 4), `rejected` with the missing headers on a wrong layout (rule 6).
 *   partnerImports         listPartnerBookImports for the tenant with who uploaded (rule 7: the tenant's partner user by name, else
 *                          "Supermortgage" — a staff or seed actor is never named to the partner).
 *   partnerImportReport    partnerBookReport for one of the tenant's imports (another tenant's → 404 NOT_FOUND) with 34.3's per-loan
 *                          lines (bookImportDetail); the servicer loan numbers in full for partner_admin / partner_ops, the last four
 *                          for partner_auditor (rule 5, Open question 2).
 *   partnerStatus          partnerBookStatus narrowed to the tenant (rule 8): as-of, next expected (33.1's clock), late, holds, counts;
 *                          an empty book before the first import ("Upload a tape to open the book.").
 *   partnerHolds           holdsOf / 34.3's hold queue for the tenant, partner-grade (rule 9): last four, first name + last initial,
 *                          state, the last as-of the loan appeared on, the partner's latest as-of, held since; no resolve control.
 */
import type { IncomingMessage } from "node:http";
import type { Actor } from "../../kernel/events/index.ts";
import { lastFour } from "../../domain/partner-book/import.ts";
import { bookImportDetail, type ImportLoanLine } from "../book-ops/history.ts";
import { bookLoans } from "../book-ops/loans.ts";
import { importPartnerBook, listPartnerBookImports, partnerBookReport, partnerBookStatus, partnerPartyByName, type PartnerBookImportInput, type PartnerBookImportListing, type PartnerBookImportResult, type PartnerBookStatus } from "../partner-book.ts";
import { readPartnerBookFiles, type UploadFile } from "../partner-book-input.ts";
import type { Runtime } from "../app.ts";
import { firstNameLastInitial } from "./mask.ts";
import { notFound, tenantFilter, type TenantScope } from "./scope.ts";

type Json = Record<string, unknown>;
/** The one profile of V1 (rule 3, Open question 1): registered by 33.1 for the first partner; never a form field. */
export const PARTNER_PROFILE: PartnerBookImportInput["profile"] = "m3-v1";
/** The multipart fields the partner route reads; every other field is dropped before the parse (rule 2). */
export const PARTNER_UPLOAD_FIELDS = ["as_of_date", "tape", "supplement"] as const;
/** The Book page's two sentences (Outputs and artifacts). */
export const BOOK_COPY = { upload: "Uploading refreshes monitored facts. It does not transfer servicing.", empty: "Upload a tape to open the book." } as const;

export interface PartnerImportInput { readonly as_of_date: string; readonly tape: UploadFile; readonly supplement?: UploadFile }

/** Rule 2: the body's `as_of_date` and files; `partner`, `partner_party_id`, `nmlsr_id`, `profile` and any other field are dropped (listed in `dropped` for the log line, never for the answer). */
export async function partnerImportInputOf(req: IncomingMessage): Promise<{ input: PartnerImportInput; dropped: string[] }> {
  const { fields, tape, supplement } = await readPartnerBookFiles(req);
  const dropped = Object.keys(fields).filter((k) => !(PARTNER_UPLOAD_FIELDS as readonly string[]).includes(k)).sort();
  const asOf = fields["as_of_date"];
  if (typeof asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new RangeError("as_of_date is required (YYYY-MM-DD)");
  if (!tape) throw new RangeError("tape is required (.xlsx or .csv)");
  return { input: { as_of_date: asOf, tape, ...(supplement ? { supplement } : {}) }, dropped };
}

/** The import's `partner` from the tenant (rule 2): the parties{servicer} row and the `partners/<id>` entity; nothing from the request. */
export async function tenantPartner(rt: Runtime, scope: TenantScope): Promise<PartnerBookImportInput["partner"]> {
  const row = (await rt.db.query<{ legal_name: string; servicer_number: string | null; mers_org_id: string | null; nmlsr_id: string | null }>(`SELECT legal_name, servicer_number, mers_org_id, contact->>'nmlsr_id' AS nmlsr_id FROM parties WHERE id = $1 AND party_type = 'servicer'`, [scope.partner_party_id]))[0];
  if (!row) throw notFound("partner");
  const entity = await rt.entities.current("partners", scope.partner_party_id);
  const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const nmlsr = s(entity?.data["nmlsr_id"]) ?? s(row.nmlsr_id);
  if (!nmlsr) throw new RangeError("the partner's NMLSR id is not registered on the platform (33.1 Operational prerequisites: the partners entity or the servicer row's contact)");
  const servicerNumber = s(entity?.data["servicer_number"]) ?? s(row.servicer_number); const mers = s(entity?.data["mers_org_id"]) ?? s(row.mers_org_id);
  return { legal_name: row.legal_name, nmlsr_id: nmlsr, ...(servicerNumber ? { servicer_number: servicerNumber } : {}), ...(mers ? { mers_org_id: mers } : {}) };
}

/** Rule 5 / Open question 2: the servicer loan numbers on a report are the partner's own file's — in full to partner_admin and partner_ops, the last four to partner_auditor. */
export function maskReportNumbers<T extends PartnerBookImportResult>(r: T, role: string): T {
  if (role !== "partner_auditor") return r;
  const num = (o: Json): Json => (typeof o["servicer_loan_number"] === "string" ? { ...o, servicer_loan_number: lastFour(o["servicer_loan_number"] as string) } : o);
  const report = r.report as unknown as Json;
  const gapsByLoan = report["gaps_by_loan"] && typeof report["gaps_by_loan"] === "object" ? Object.fromEntries(Object.entries(report["gaps_by_loan"] as Json).map(([k, v]) => [lastFour(k), v])) : report["gaps_by_loan"];
  const masked: Json = { ...report, exceptions: Array.isArray(report["exceptions"]) ? (report["exceptions"] as Json[]).map(num) : report["exceptions"], loans: Array.isArray(report["loans"]) ? (report["loans"] as Json[]).map(num) : report["loans"], not_on_tape: Array.isArray(report["not_on_tape"]) ? (report["not_on_tape"] as Json[]).map(num) : report["not_on_tape"], gaps_by_loan: gapsByLoan };
  return { ...r, report: masked as unknown as T["report"], loans: r.loans.map((l) => ({ ...l, servicer_loan_number: lastFour(l.servicer_loan_number) })) };
}

/** Rule 1: 33.1's `book.import` through importPartnerBook, the partner user as actor, the partner the session's (rule 2), the profile registered (rule 3). */
export async function partnerImport(rt: Runtime, scope: TenantScope, actor: Actor, input: PartnerImportInput): Promise<PartnerBookImportResult> {
  const partner = await tenantPartner(rt, scope);
  // 33.1's import finds the servicer row by legal name (partnerPartyByName): the row it will attach to must be the session's tenant, else nothing runs
  const byName = await partnerPartyByName(rt.db, partner.legal_name);
  if (!byName || byName.id !== scope.partner_party_id) throw new Error(`the servicer row 33.1 resolves for "${partner.legal_name}" is not the session's tenant — the import is not dispatched (36.2 rule 2)`);
  return importPartnerBook(rt, { partner, as_of_date: input.as_of_date, profile: PARTNER_PROFILE, tape: input.tape, ...(input.supplement ? { supplement: input.supplement } : {}) }, actor);
}

/** Rule 7: who uploaded — the tenant's partner user by name when the import's actor is one, else "Supermortgage" (a staff or seed actor is never named to the partner). */
async function uploadersOf(rt: Runtime, scope: TenantScope, importIds: readonly string[]): Promise<Map<string, string>> {
  if (!importIds.length) return new Map();
  const rows = await rt.db.query<{ import_id: string; name: string | null; partner_user_id: string | null }>(
    `SELECT i.id::text AS import_id, u.name, u.id::text AS partner_user_id FROM partner_book_imports i
       LEFT JOIN partner_users u ON u.partner_party_id = i.partner_party_id AND i.actor_id = 'human:' || u.id::text
      WHERE i.partner_party_id = $1 AND i.id = ANY($2::uuid[])`, [scope.partner_party_id, importIds]);
  return new Map(rows.map((r) => [r.import_id, r.partner_user_id ? (r.name ?? "a partner user") : "Supermortgage"]));
}

export type PartnerImportListing = PartnerBookImportListing & { uploaded_by: string };
/** GET /v1/partner/book/imports (rule 7): the tenant's imports newest first, as listPartnerBookImports returns them, with who uploaded. */
export async function partnerImports(rt: Runtime, scope: TenantScope): Promise<{ partner_party_id: string; imports: PartnerImportListing[] }> {
  const rows = await listPartnerBookImports(rt, scope.partner_party_id);   // filtered by the tenant, never null (rule 2)
  const who = await uploadersOf(rt, scope, rows.map((r) => r.import_id));
  return { partner_party_id: scope.partner_party_id, imports: rows.filter((r) => r.partner_party_id === scope.partner_party_id).map((r) => ({ ...r, uploaded_by: who.get(r.import_id) ?? "Supermortgage" })) };
}

export type PartnerImportReport = PartnerBookImportResult & { created_at: string; uploaded_by: string; lines: ImportLoanLine[]; not_on_tape: { loan_id: string; servicer_loan_number: string; last_as_of_date: string }[] };
/** GET /v1/partner/book/imports/{id} (rules 5, 7): the report 33.1's `book.report` reads, the tenant's or 404, with 34.3's per-loan lines; the numbers masked for partner_auditor. */
export async function partnerImportReport(rt: Runtime, scope: TenantScope, importId: string, role: string): Promise<PartnerImportReport> {
  const r = await partnerBookReport(rt, importId);
  if (!r || r.partner_party_id !== scope.partner_party_id) throw notFound("import");   // rule 2: another tenant's import does not exist here
  const detail = await bookImportDetail(rt, importId);
  const who = await uploadersOf(rt, scope, [importId]);
  const masked = maskReportNumbers(r, role);
  const four = (n: string): string => (role === "partner_auditor" ? lastFour(n) : n);
  return { ...masked, uploaded_by: who.get(importId) ?? "Supermortgage", lines: (detail?.lines ?? []).map((l) => ({ ...l, servicer_loan_number: four(l.servicer_loan_number) })), not_on_tape: (detail?.not_on_tape ?? []).map((n) => ({ ...n, servicer_loan_number: four(n.servicer_loan_number) })) };
}

export type PartnerStatusLine = PartnerBookStatus & { empty: boolean; copy: string };
/** GET /v1/partner/book/status (rule 8): partnerBookStatus narrowed to the tenant; before the first import an empty line with the page's sentence. */
export async function partnerStatus(rt: Runtime, scope: TenantScope, now: string = rt.clock.now()): Promise<PartnerStatusLine> {
  const mine = (await partnerBookStatus(rt, now)).find((p) => p.partner_party_id === scope.partner_party_id);
  if (mine) return { ...mine, empty: mine.as_of_date === null, copy: mine.as_of_date === null ? BOOK_COPY.empty : BOOK_COPY.upload };
  const row = (await rt.db.query<{ legal_name: string }>(`SELECT legal_name FROM parties WHERE id = $1 AND party_type = 'servicer'`, [scope.partner_party_id]))[0];
  if (!row) throw notFound("partner");
  return { partner_party_id: scope.partner_party_id, partner_legal_name: row.legal_name, as_of_date: null, imports: 0, monitored_loans: 0, on_hold: 0, next_expected: null, tape_clock: null, late: false, empty: true, copy: BOOK_COPY.empty };
}

export type PartnerHoldRow = { loan_id: string; servicer_loan_last4: string; homeowner: { party_id: string | null; name: string | null }; state: string | null; status: string; last_as_of_date: string; partner_as_of_date: string; held_since: string | null };
/** GET /v1/partner/book/holds (rule 9): the tenant's loans on hold as 34.3's hold queue finds them, partner-grade, without the resolve control. */
export async function partnerHolds(rt: Runtime, scope: TenantScope, now: string = rt.clock.now()): Promise<{ partner_party_id: string; as_of_date: string | null; count: number; holds: PartnerHoldRow[] }> {
  const book = await bookLoans(rt, tenantFilter(scope, { hold: true }), now);   // filter.partner = the tenant, never null (rule 2)
  const stateOf = new Map(book.loans.map((l) => [l.loan_id, l.state]));
  const holds = book.hold_queue.filter((h) => h.partner_party_id === scope.partner_party_id).map((h): PartnerHoldRow => ({ loan_id: h.loan_id, servicer_loan_last4: lastFour(h.servicer_loan_number), homeowner: { party_id: h.homeowner.party_id, name: firstNameLastInitial(h.homeowner.legal_name) }, state: stateOf.get(h.loan_id) ?? null, status: h.status, last_as_of_date: h.last_as_of_date, partner_as_of_date: h.partner_as_of_date, held_since: h.not_on_tape_since }));
  return { partner_party_id: scope.partner_party_id, as_of_date: holds[0]?.partner_as_of_date ?? null, count: holds.length, holds };
}
