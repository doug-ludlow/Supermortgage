/**
 * §34.3 process-owned tools — the `portfolio` agent's `book.history`, `book.loans`, `book.loan`, `book.day` and
 * `book.daily_report` (spec/sections/34-operator-portal/34-3-*.md "AI agent design"), defined with
 * `defineTools("34.3", "portfolio", defs)` and spread by ./index.ts. Every tool string is one spec/registry/agents.json names
 * for 34.3. Thin bus wrappers over src/runtime/book-ops/* (the runtime seam the portal's routes call directly):
 *
 *   book.history       read   the imports of a partner with what each changed; `import_id` → one import's report and per-loan lines.
 *   book.loans         read   the book with its latest facts and the hold queue; filters partner / status / hold / verdict / ready.
 *   book.loan          read   a loan's page: facts by as-of, terms history, invitations (hashes and dates), reviews and readiness by day, offers, clocks.
 *   book.day           read   the day across the book: counts by verdict and by missing item, the lists, the run receipts vs 07:30 ET.
 *   book.daily_report  write  the per-partner-day report row (the one row the five tools write) and its decision
 *                             {partner_party_id, as_of_date, counts, fair_lending_extract_id, rule_set_version partner_book.report.v1,
 *                             model_version deterministic, prompt_version 34.3-v1, confidence 1} — recorded by the runtime function in its
 *                             own unit of work, so the bus records no second decision for it; `op=export` (compliance) makes the hashed document.
 *
 * Guardrails (the paragraph's list): READ_ONLY (the five tools write only the report row — any instruction to write, change or
 * resolve is refused; uploads and resolutions are 33.1's book.import / book.resolve), NO_COMPUTED_FIGURE (no figure enters and
 * none is estimated — a figure the rows do not carry is absent), ROLE_MASK (the projection is masked for the role before it
 * leaves; an instruction to unmask is refused — 34.2's directory.unmask is the logged path), NO_DESTINATION (invitations are hashes
 * and dates; a destination in the input is refused).
 */
import { defineTools, compute, guard, never, str, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Runtime } from "../../runtime/app.ts";
import { dayOf, isUuid } from "../../runtime/book-ops/common.ts";
import { bookHistory, bookImportDetail } from "../../runtime/book-ops/history.ts";
import { bookLoans } from "../../runtime/book-ops/loans.ts";
import { bookLoan } from "../../runtime/book-ops/loan.ts";
import { bookDay } from "../../runtime/book-ops/day.ts";
import { REPORT_RULE_SET_VERSION, bookDailyReport, exportDailyReport } from "../../runtime/book-ops/report.ts";

const PROCESS_34_3 = "34.3"; const AGENT = "portfolio";
/** 34.1 rule 2: ops_analyst, officer and compliance read the partner-book views (admin touches no borrower). */
const HUMAN_ROLES: readonly string[] = ["ops_analyst", "officer", "compliance"];
const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const boolOf = (i: ToolInput, k: string): boolean | null => (i[k] === true || i[k] === "true" ? true : i[k] === false || i[k] === "false" ? false : null);
const has = (i: ToolInput, k: string): boolean => i[k] !== undefined && i[k] !== null && i[k] !== "" && i[k] !== false;

// ───────── guardrails ─────────

/** READ_ONLY: the five tools write only the report row — an instruction to write, change, resolve, import or delete anything is refused (33.1's book.import / book.resolve are the write paths). */
const WRITE_KEYS = ["changes", "data", "write", "update", "delete", "resolve", "resolution", "import", "upload", "set_status", "status_to"];
const WRITE_OPS = new Set(["write", "create", "update", "delete", "resolve", "import", "upload", "set"]);
const READ_ONLY = never("READ_ONLY", "34.3 AI agent design: 'READ_ONLY (the five tools write only the report row)'; uploads and resolutions are 33.1's own book.import and book.resolve, dispatched with the staff actor", (i) => WRITE_KEYS.some((k) => has(i, k)) || (typeof i.op === "string" && WRITE_OPS.has(i.op)), "these tools project section 33's rows; nothing is written but the daily report row — resolve a loan with 33.1 book.resolve, upload with 33.1 book.import");
/** NO_COMPUTED_FIGURE: rule 7 — every figure shown is a stored fact, a stored engine figure or a count of rows; no figure enters here and none is estimated. */
const FIGURE_KEYS = new Set(["upb_cents", "upb", "balance_cents", "value_cents", "value", "estimated_value_cents", "rate", "note_rate", "note_rate_pct", "pi_cents", "payment_cents", "ti_cents", "ltv", "npv_cents", "candidate_rate_pct", "figure", "estimate", "compute", "estimate_value", "projected_upb_cents"]);
const NO_COMPUTED_FIGURE = never("NO_COMPUTED_FIGURE", "34.3 rule 7: 'Nothing is computed about a loan here. Every figure shown is a stored fact, a stored engine figure or a count of rows; a value the portal cannot find is shown as absent, never estimated'", (i) => Object.keys(i).some((k) => FIGURE_KEYS.has(k)), "no figure enters and none is estimated: a value the rows do not carry is absent");
/** ROLE_MASK: the projection is masked for the role before it leaves the tool (34.2 rule 2: `m…@example.com`, `···0101`); an unmask is 34.2's own logged action. */
const UNMASK_KEYS = ["unmask", "unmasked", "raw_contact", "include_contact", "reveal", "full_contact", "plain"];
const ROLE_MASK = never("ROLE_MASK", "34.3 AI agent design: 'ROLE_MASK (34.2)' — 34.2 rule 2: a homeowner's contact leaves masked; the unmask is directory.unmask with a reason, logged, for compliance or officer", (i) => UNMASK_KEYS.some((k) => has(i, k)), "the partner-book views are masked for every role; use 34.2 directory.unmask with a reason");
/** NO_DESTINATION: invitations are shown as hashes and dates; no destination enters or leaves. */
const DESTINATION_KEYS = ["destination", "destinations", "email", "phone", "e_mail", "mobile", "include_destination"];
const NO_DESTINATION = never("NO_DESTINATION", "34.3 AI agent design: 'NO_DESTINATION (invitations shown as hashes and dates)'; 33.1 rule 3: never a destination in a log line or a report", (i) => DESTINATION_KEYS.some((k) => has(i, k)), "invitations are hashes and dates: no destination is looked up, shown or accepted here");
const GUARDS = [READ_ONLY, NO_COMPUTED_FIGURE, ROLE_MASK, NO_DESTINATION];
/** ROLE_REQUIRED: rule 6 / Operational prerequisites — the daily report's export is `compliance`'s (the sweep produces rows and never exports; there is no flag that stands in for the role). */
const EXPORT_IS_COMPLIANCE = guard("ROLE_REQUIRED", "34.3 rule 6 ('exportable by compliance as a document with a hash') / Operational prerequisites; 34.1 rule 3 (ROLE_REQUIRED{role})", (i, ctx) => (i.op === "export" && !(ctx.actor.kind === "human" && ctx.actor.role === "compliance") ? "book.daily_report export requires compliance" : undefined));
const asOfOf = (i: ToolInput, ctx: CommandContext, rt: Runtime): string => str(i, "as_of_date") || str(i, "as_of") || dayOf(ctx.now || rt.clock.now());

// ───────── the tools ─────────

export const TOOLS_34_3: readonly ToolDef[] = defineTools(PROCESS_34_3, AGENT, [
  { name: "book.history", kind: "read", humanRoles: HUMAN_ROLES, guardrails: GUARDS, handler: compute(async (i, _ctx, rt) => {
    const runtime = runtimeOf(rt);
    if (str(i, "import_id")) { const d = await bookImportDetail(runtime, str(i, "import_id")); if (!d) throw new RangeError(`no import ${str(i, "import_id")}`); return d; }
    return bookHistory(runtime, str(i, "partner_id") || str(i, "partner") || null, { lines: boolOf(i, "lines") !== false, ...(typeof i["limit"] === "number" ? { limit: i["limit"] } : {}) });
  }) },
  { name: "book.loans", kind: "read", humanRoles: HUMAN_ROLES, guardrails: GUARDS, handler: compute(async (i, _ctx, rt) =>
    bookLoans(runtimeOf(rt), { partner: str(i, "partner_id") || str(i, "partner") || null, status: str(i, "status") || null, hold: boolOf(i, "hold"), verdict: str(i, "verdict") || null, ready: boolOf(i, "ready") })) },
  { name: "book.loan", kind: "read", humanRoles: HUMAN_ROLES, guardrails: GUARDS, handler: compute(async (i, ctx, rt) => {
    const loanId = str(i, "loan_id") || ctx.loanId; if (!isUuid(loanId)) throw new RangeError("book.loan needs loan_id (a uuid)");
    const l = await bookLoan(runtimeOf(rt), loanId); if (!l) throw new RangeError(`no monitored loan ${loanId} on a partner book`); return l;
  }) },
  { name: "book.day", kind: "read", humanRoles: HUMAN_ROLES, guardrails: GUARDS, handler: compute(async (i, ctx, rt) => { const runtime = runtimeOf(rt); return bookDay(runtime, { partner: str(i, "partner_id") || str(i, "partner") || null, as_of: asOfOf(i, ctx, runtime) }); }) },
  // the one write: the report row (rule 6) — produced idempotently per partner-day; `op=export` is compliance's hashed document (the decision is the runtime function's own, in its unit of work)
  { name: "book.daily_report", kind: "write", ruleSetVersion: REPORT_RULE_SET_VERSION, humanRoles: HUMAN_ROLES, guardrails: [EXPORT_IS_COMPLIANCE, NO_COMPUTED_FIGURE, ROLE_MASK, NO_DESTINATION, never("READ_ONLY", "34.3 AI agent design: 'READ_ONLY (the five tools write only the report row)'", (i) => WRITE_KEYS.some((k) => has(i, k)) || (typeof i.op === "string" && i.op !== "produce" && i.op !== "export" && i.op !== "read"), "book.daily_report writes the report row and, on op=export, its document; nothing else")],
    handler: compute(async (i, ctx, rt) => {
      const runtime = runtimeOf(rt); const partner = str(i, "partner_id") || str(i, "partner"); if (!isUuid(partner)) throw new RangeError("book.daily_report needs partner_id (a uuid)");
      const as_of = asOfOf(i, ctx, runtime);
      if (i.op === "export") {   // EXPORT_IS_COMPLIANCE refused every other caller before this ran; the guard is repeated so a bypass of the bus table still cannot export
        if (!(ctx.actor.kind === "human" && ctx.actor.role === "compliance")) throw new RangeError("book.daily_report export requires compliance (34.3 rule 6: 'exportable by compliance as a document with a hash')");
        const x = await exportDailyReport(runtime, { partner, as_of }, ctx.actor);
        return { document_id: x.document_id, sha256: x.sha256, byte_size: x.byte_size, report: x.report, created: x.created };
      }
      // `produced_by` is the actor's (`human:<id>` / `agent:portfolio`) — never the input's; `sweep` is the sweep hook's own direct call (book-ops/routes.ts)
      const r = await bookDailyReport(runtime, { partner, as_of }, ctx.actor);
      return { report: r.report, produced: r.produced };
    }),
    decision: () => null },
]);
