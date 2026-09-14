/**
 * §34.3 — the portal's partner-book routes as a table the console server mounts, and the sweep hook.
 *
 *   bookOpsRoutes(deps)   `{method, path, roles, handler}` per route of the spec's Inputs: the GETs (partners, imports, an import,
 *                         loans, a loan, reviews, readiness, daily-report) and POST …/loans/{id}/resolve, which dispatches 33.1's
 *                         `book.resolve` through Runtime.execute with the staff member as the actor (`{human, <staff_user_id>, ops_analyst}`)
 *                         — a ToolNotFound answers 501 until the tool lands. Each GET logs `book.viewed{staff_user_id, partner_id, view}`
 *                         (global); 34.1's action log carries the request itself (the server writes `staff_actions` around the handler,
 *                         with `command` / `subject` from the response). The upload (`POST …/imports` → 33.1 `book.import`) is mounted by
 *                         the integration step from src/runtime/partner-book.ts importPartnerBook, not here.
 *                         Roles (34.1 rule 2): ops_analyst, officer and compliance read the views; ops_analyst resolves; compliance exports.
 *                         The handler re-checks the role (403 ROLE_REQUIRED{role}) so the table's `roles` and the handler agree.
 *   sweepDailyReports     rule 6: after 33.3's pass, the daily report per partner for the day (idempotent — bookDailyReport appends
 *                         only when something changed) and, from 07:45 ET, one `ops_analyst` escalation per partner-day whose review or
 *                         readiness receipt is missing (AI agent design: escalations; the clocks' own breaches are 33.2's and 33.3's).
 */
import type { Actor } from "../../kernel/events/index.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { EscalationService } from "../../app/escalations.ts";
import { CommandRefused } from "../../app/commands.ts";
import { RoleDenied } from "../../app/roles.ts";
import { Runtime, ToolNotFound } from "../app.ts";
import { type Row, ET, PORTFOLIO_AGENT, RECEIPT_ESCALATE_ET, RESOLUTIONS, atEt, dayOf, isDate, isUuid, partnersOf, recordBookViewed, str } from "./common.ts";
import { bookHistory, bookImportDetail } from "./history.ts";
import { bookLoans } from "./loans.ts";
import { bookLoan } from "./loan.ts";
import { bookDay } from "./day.ts";
import { bookDailyReport, exportDailyReport, latestDailyReport, listDailyReports } from "./report.ts";

export type StaffRole = "ops_analyst" | "officer" | "compliance" | "admin";
export const READ_ROLES: readonly StaffRole[] = ["ops_analyst", "officer", "compliance"];
export const RESOLVE_ROLES: readonly StaffRole[] = ["ops_analyst"];
export const EXPORT_ROLES: readonly StaffRole[] = ["compliance"];
export const BOOK_OPS_PREFIX = "/ops/api/partner-book";

/** The staff member the server resolved from the session (34.1 rule 5) and the role the request acts under (rule 3). */
export interface StaffRequestActor { readonly staff_user_id: string; readonly role: string; readonly session_id?: string | null }
export interface BookOpsRequest { readonly params: Record<string, string>; readonly query: Record<string, string>; readonly body: Record<string, unknown>; readonly staff: StaffRequestActor }
/** `command` and `subject` are what the server's staff_actions row records beside the route. */
export interface BookOpsResponse { readonly status: number; readonly body: unknown; readonly command?: string | null; readonly subject?: { kind: string; id: string } | null }
export interface BookOpsRoute { readonly method: "GET" | "POST"; readonly path: string; readonly roles: readonly StaffRole[]; readonly handler: (req: BookOpsRequest) => Promise<BookOpsResponse> }
export interface BookOpsDeps { readonly runtime: Runtime }

export const staffActor = (s: StaffRequestActor): Actor => ({ kind: "human", id: s.staff_user_id, role: s.role });
const refused = (status: number, code: string, error: string, extra: Row = {}): BookOpsResponse => ({ status, body: { error, code, ...extra } });
const roleOk = (req: BookOpsRequest, roles: readonly StaffRole[]): BookOpsResponse | null => (roles.includes(req.staff.role as StaffRole) ? null : refused(403, "ROLE_REQUIRED", `this route needs ${roles.join(" or ")}`, { role: roles[0], held: [req.staff.role] }));
const bool = (v: string | undefined): boolean | null => (v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : null);
const partnerOf = (req: BookOpsRequest): string | null => (isUuid(req.query["partner"]) ? req.query["partner"] : null);

/** A route: the role gate, the handler, the `book.viewed` receipt on a successful GET. */
function route(rt: Runtime, method: BookOpsRoute["method"], path: string, roles: readonly StaffRole[], view: string | null, fn: (req: BookOpsRequest, actor: Actor) => Promise<BookOpsResponse>): BookOpsRoute {
  return { method, path, roles, handler: async (req) => {
    const denied = roleOk(req, roles); if (denied) return denied;
    const actor = staffActor(req.staff);
    try {
      const res = await fn(req, actor);
      if (view && res.status < 300) await recordBookViewed(rt, { staff_user_id: req.staff.staff_user_id, partner_id: partnerOf(req) ?? (res.subject?.kind === "partner" ? res.subject.id : null), view, ...(res.subject ? { subject: { subject_kind: res.subject.kind, subject_id: res.subject.id } } : {}) }, actor);
      return res;
    } catch (e) {
      if (e instanceof ToolNotFound) return refused(501, "NOT_IMPLEMENTED", e.message);
      if (e instanceof CommandRefused) return refused(e.code === "ROLE_DENIED" || e.code === "HUMAN_ONLY" ? 403 : 409, e.code, e.message, { citation: e.citation });
      if (e instanceof RoleDenied) return refused(403, "ROLE_DENIED", e.message);
      if (e instanceof RangeError) return refused(400, "BAD_REQUEST", e.message);
      throw e;
    }
  } };
}

export function bookOpsRoutes(deps: BookOpsDeps): BookOpsRoute[] {
  const rt = deps.runtime; const P = BOOK_OPS_PREFIX;
  return [
    route(rt, "GET", `${P}/partners`, READ_ROLES, "partners", async () => ({ status: 200, body: { partners: await partnersOf(rt) } })),
    route(rt, "GET", `${P}/imports`, READ_ROLES, "imports", async (req) => ({ status: 200, body: await bookHistory(rt, partnerOf(req), { lines: bool(req.query["lines"]) !== false }) })),
    route(rt, "GET", `${P}/imports/{id}`, READ_ROLES, "import", async (req) => { const d = await bookImportDetail(rt, req.params["id"] ?? ""); return d ? { status: 200, body: d, subject: { kind: "partner_book_import", id: d.import_id } } : refused(404, "NOT_FOUND", "no such import"); }),
    route(rt, "GET", `${P}/loans`, READ_ROLES, "loans", async (req) => ({ status: 200, body: await bookLoans(rt, { partner: partnerOf(req), status: str(req.query["status"]), hold: bool(req.query["hold"]), verdict: str(req.query["verdict"]), ready: bool(req.query["ready"]) }) })),
    route(rt, "GET", `${P}/loans/{id}`, READ_ROLES, "loan", async (req) => { const l = await bookLoan(rt, req.params["id"] ?? ""); return l ? { status: 200, body: l, subject: { kind: "loan", id: l.loan.loan_id } } : refused(404, "NOT_FOUND", "no such monitored loan"); }),
    route(rt, "GET", `${P}/reviews`, READ_ROLES, "reviews", async (req) => ({ status: 200, body: await bookDay(rt, { partner: partnerOf(req), as_of: req.query["as_of"] ?? dayOf(rt.clock.now()) }) })),
    route(rt, "GET", `${P}/readiness`, READ_ROLES, "readiness", async (req) => ({ status: 200, body: await bookDay(rt, { partner: partnerOf(req), as_of: req.query["as_of"] ?? dayOf(rt.clock.now()) }) })),
    // the daily report: GET produces on demand (book.daily_report) and lists the partner's rows; POST …/export is compliance's hashed document
    route(rt, "GET", `${P}/daily-report`, READ_ROLES, "daily_report", async (req, actor) => {
      const partner = partnerOf(req); if (!partner) return { status: 200, body: { reports: await listDailyReports(rt, null) } };
      const asOf = req.query["as_of"] ?? dayOf(rt.clock.now()); if (!isDate(asOf)) return refused(400, "BAD_REQUEST", "as_of is a date (YYYY-MM-DD)");
      const r = await bookDailyReport(rt, { partner, as_of: asOf }, actor);
      return { status: 200, body: { ...r.report, produced: r.produced, history: await listDailyReports(rt, partner) }, command: r.produced ? "book.daily_report" : null, subject: { kind: "partner_book_daily_report", id: r.report.id } };
    }),
    route(rt, "POST", `${P}/daily-report/export`, EXPORT_ROLES, null, async (req, actor) => {
      const partner = isUuid(req.body["partner"]) ? req.body["partner"] : partnerOf(req); const asOf = str(req.body["as_of"]) ?? req.query["as_of"] ?? dayOf(rt.clock.now());
      if (!partner) return refused(400, "BAD_REQUEST", "partner is a uuid"); if (!isDate(asOf)) return refused(400, "BAD_REQUEST", "as_of is a date (YYYY-MM-DD)");
      const x = await exportDailyReport(rt, { partner, as_of: asOf }, actor);
      return { status: x.created ? 201 : 200, body: { document_id: x.document_id, sha256: x.sha256, byte_size: x.byte_size, report_id: x.report.id, as_of_date: x.report.as_of_date, partner_party_id: x.report.partner_party_id, created: x.created, content: x.content }, command: "book.daily_report:export", subject: { kind: "document", id: x.document_id } };
    }),
    route(rt, "POST", `${P}/loans/{id}/resolve`, RESOLVE_ROLES, null, async (req, actor) => {
      const loanId = req.params["id"] ?? ""; if (!isUuid(loanId)) return refused(400, "BAD_REQUEST", "loan id is a uuid");
      const resolution = str(req.body["resolution"]) ?? ""; const reason = (str(req.body["reason"]) ?? "").trim();
      if (!RESOLUTIONS.includes(resolution)) return refused(400, "BAD_REQUEST", `resolution is one of ${RESOLUTIONS.join(" | ")} (33.1 rule 8)`);
      if (!reason) return refused(400, "BAD_REQUEST", "reason is required");
      // 33.1 `book.resolve` on the bus with the staff member as the actor — the bus refuses any role but ops_analyst; a ToolNotFound is 501 until 33.1's tool lands
      const r = await rt.execute({ process: "33.1", name: "book.resolve", loanId, actor, input: { loan_id: loanId, resolution, reason } });
      // the decision's persisted id (Runtime.execute's `decisions`); `decisionId` is the bus's "queued" placeholder, never an id
      const decisionId = r.decisions[0]?.id ?? null;
      rt.logger?.info("partner book loan resolved from the portal", { loan_id: loanId, resolution, staff_user_id: req.staff.staff_user_id, role: req.staff.role, events: r.events.length, decision_id: decisionId });
      return { status: 200, body: { loan_id: loanId, resolution, output: r.output, decision_id: decisionId, events: r.events.map((e) => e.type), loan: await bookLoan(rt, loanId) }, command: "book.resolve", subject: { kind: "loan", id: loanId } };
    }),
  ];
}

export interface SweepDailyReportsResult { readonly as_of_date: string; readonly produced: number; readonly partners: number; readonly escalated: number; readonly skipped: string[] }
/** The sweep hook (called after the readiness pass): the daily report per partner once 33.3's receipt of the day exists; from 07:45 ET the ops_analyst escalation for a day without its receipts. */
export async function sweepDailyReports(rt: Runtime, nowIso: string = rt.clock.now()): Promise<SweepDailyReportsResult> {
  const asOf = dayOf(nowIso); const wc = wallClock(Date.parse(nowIso), ET);
  const partners = await partnersOf(rt, nowIso);
  const readinessReceipt = (await rt.db.query<{ n: string }>(`SELECT 1 AS n FROM loan_events WHERE type = 'partner_book.readiness.run_completed' AND payload->>'as_of_date' = $1 LIMIT 1`, [asOf])).length > 0;
  let produced = 0; let escalated = 0; const skipped: string[] = [];
  const [eh, em] = RECEIPT_ESCALATE_ET.split(":").map(Number) as [number, number];
  const pastEscalation = wc.hour * 60 + wc.minute >= eh * 60 + em;
  for (const p of partners) {
    if (p.loans_monitored === 0 && p.on_hold === 0) { skipped.push(`${p.partner_party_id}: no monitored loans`); continue; }
    const reviewReceipt = (await rt.db.query<{ n: string }>(`SELECT 1 AS n FROM loan_events WHERE type = 'partner_book.review.run_completed' AND payload->>'as_of_date' = $1 AND payload->>'partner_id' = $2 LIMIT 1`, [asOf, p.partner_party_id])).length > 0;
    if (readinessReceipt) {
      try { const r = await bookDailyReport(rt, { partner: p.partner_party_id, as_of: asOf, produced_by: "sweep" }, PORTFOLIO_AGENT); if (r.produced) produced += 1; }
      catch (e) { skipped.push(`${p.partner_party_id}: ${e instanceof Error ? e.message : String(e)}`); rt.logger?.error("partner book daily report failed", { partner_party_id: p.partner_party_id, as_of_date: asOf, error: e instanceof Error ? e.message : String(e) }); }
    } else skipped.push(`${p.partner_party_id}: no readiness receipt for ${asOf} yet`);
    if (pastEscalation && (!reviewReceipt || !readinessReceipt)) {
      const existing = (await rt.db.query<{ id: string }>(`SELECT id::text AS id FROM escalations WHERE payload->>'kind' = 'partner_book_day_receipt_missing' AND payload->>'as_of_date' = $1 AND payload->>'partner_id' = $2 LIMIT 1`, [asOf, p.partner_party_id]))[0];
      if (existing) continue;
      const missing = [...(!reviewReceipt ? ["partner_book.review.run_completed"] : []), ...(!readinessReceipt ? ["partner_book.readiness.run_completed"] : [])];
      let esc: EscalationService | undefined;
      await rt.uow.run({}, async (ctx) => {
        esc = new EscalationService(ctx.events, ctx.clock);
        esc.open({ kind: "sev3", ownerRole: "ops_analyst", severity: "3", payload: { kind: "partner_book_day_receipt_missing", partner_id: p.partner_party_id, partner_legal_name: p.legal_name, as_of_date: asOf, missing, expected_by: atEt(asOf, "07:30"), noticed_at: nowIso, reason: `no ${missing.join(" / ")} receipt by ${RECEIPT_ESCALATE_ET} ET (34.3 AI agent design: escalations)` } }, PORTFOLIO_AGENT);
      }, { clock: rt.clock, commit: async (q) => { for (const e of esc?.list() ?? []) await rt.escalationRepo.save(e, q); } });
      escalated += 1;
      rt.logger?.warn("partner book day without its receipts", { partner_party_id: p.partner_party_id, as_of_date: asOf, missing });
    }
  }
  return { as_of_date: asOf, produced, partners: partners.length, escalated, skipped };
}
