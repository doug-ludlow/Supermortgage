/**
 * §23.7 process-owned tools — the `underwriter` agent's three tools over the preflight
 * (spec/sections/23-desktop-underwriter-and-the-credit-decision/23-7-*.md "AI agent design"), defined with
 * `defineTools("23.7", "underwriter", defs)` and spread by ./index.ts. Every tool string is one spec/registry/agents.json
 * names for 23.7; src/app/tools.test.ts refuses the rest.
 *
 *   runDuPreflight    act   the checks (du/preflight.ts) over an emitted document — a du_documents row read by du_document_id /
 *                           document_id / the application's latest, or bytes handed in by a runtime without a database — persisted
 *                           to du_preflight_results inside the command's transaction, `du.preflight.passed{document_id, checks}`
 *                           (opens SM_DU_PREFLIGHT_GATE) or `du.preflight.refused{document_id, code, xpath, rule}` (holds it)
 *   readDuPreflight   read  the latest du_preflight_results row for a document or an application, every check with its outcome
 *   explainDuRefusal  read  a refusal code → the 23.2 structural condition or the 32.x borrower card that would clear it; never DU's
 *                           words to the borrower (Outputs)
 *
 * Guardrails encode the paragraph: no bypass exists — there is no `officer` waiver for a preflight refusal (DU_PREFLIGHT_NO_WAIVER),
 * because every refusal is a document DU would reject; the agent never edits the document to make a check pass
 * (DU_PREFLIGHT_NO_EDIT); a refused document is never transmitted (DU_PREFLIGHT_NO_TRANSMIT — transmission is 23.1's submit,
 * which evaluates the gate itself). Decision record: {document_id, passed, checks, rule_set_version}.
 */
import { defineTools, compute, never, str, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { isUuid, type Queryable } from "../../infra/db/client.ts";
import { readDuDocument } from "../../domain/underwriting/du/persist.ts";
import { DU_PREFLIGHT_CODES, DU_PREFLIGHT_RULES, DU_PREFLIGHT_RULE_SET, emitDuPreflight, persistDuPreflight, readDuPreflight as readDuPreflightRow, runDuPreflight, type PreflightCode, type PreflightCasefile } from "../../domain/underwriting/du/preflight.ts";
import type { SubmissionType } from "../../domain/underwriting/ops-23-1.ts";

export const PROCESS_23_7 = "23.7";
type P = Record<string, unknown>;

const dbOf = (rt: ToolRuntime): Queryable | undefined => rt.services["db"] as Queryable | undefined;
/** Missing-input refusals are RangeErrors (never TypeErrors) — src/app/tools.test.ts executes every tool with `{}`. */
const need = (i: ToolInput, ...keys: string[]): void => { const missing = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (missing.length) throw new RangeError(`23.7 tool needs ${missing.join(", ")}`); };
const casefileIn = (i: ToolInput, rt: ToolRuntime): PreflightCasefile => {
  if (i["casefile"] && typeof i["casefile"] === "object") return i["casefile"] as PreflightCasefile;
  need(i, "casefile_id");
  const rec = rt.store.get("du_casefiles", str(i, "casefile_id"));
  if (!rec) throw new RangeError(`23.7: no du_casefiles record ${str(i, "casefile_id")} (pass casefile)`);
  return rec.data as unknown as PreflightCasefile;
};

/**
 * Where a refusal goes (Outputs; Open question 1 default: a borrower ask goes to 32.x directly, "23.2 is for what DU said, and
 * DU has not spoken yet"). `borrower_text` is what the rail may say — a plain ask, never the code, the XPath or DU's words.
 */
export const DU_REFUSAL_ROUTES: Readonly<Record<PreflightCode, { readonly owner: "23.2" | "32.x" | "22.4" | "23.1" | "23.5" | "23.6"; readonly clears: string; readonly borrower_text: string | null }>> = {
  DU_PREFLIGHT_CREDENTIALS: { owner: "23.1", clears: "the casefile's seller_number / system_id_ref / tsp_product_ref (23.1 createCasefile; a TSP credential change is an officer act)", borrower_text: null },
  DU_PREFLIGHT_DANGLING_ARC: { owner: "23.6", clears: "an emitter defect: an arc names a label the document lacks — re-emit from the graph; nothing for the borrower", borrower_text: null },
  DU_PREFLIGHT_DUPLICATE_LABEL: { owner: "23.6", clears: "an emitter defect: two containers carry one label — re-emit from the graph", borrower_text: null },
  DU_PREFLIGHT_UNKNOWN_ARCROLE: { owner: "23.6", clears: "an arcrole outside DU_ARCROLES — re-emit; the table is generated from the ArcRoles tab", borrower_text: null },
  DU_PREFLIGHT_DISPUTED_ARC: { owner: "23.5", clears: "a disputed UNDERWRITING_VERIFICATION arc on the wire — nobody picks an endpoint (23.5 Open question 2); drop it", borrower_text: null },
  DU_PREFLIGHT_NO_GRAPH: { owner: "23.6", clears: "owned containers with no RELATIONSHIPS block — re-emit from the graph", borrower_text: null },
  DU_PREFLIGHT_BORROWER_COUNT: { owner: "23.2", clears: "a structural condition: more than four borrowers on one DU casefile — restructure (23.2), never drop a borrower silently", borrower_text: "This loan lists more than four borrowers. We will reach out about how to structure it." },
  DU_PREFLIGHT_CARDINALITY: { owner: "23.2", clears: "a container over its DU limit (50 assets / liabilities / expenses …) — 22.4 consolidation or a 23.2 restructuring condition", borrower_text: null },
  DU_PREFLIGHT_SEQUENCE: { owner: "23.6", clears: "an emitter defect: SequenceNumbers not 1..n — re-emit", borrower_text: null },
  DU_PREFLIGHT_ORPHAN: { owner: "22.4", clears: "an asset, liability or expense with no owner — 22.4's reconciliation names the owner (the database refuses the commit; the document shows it)", borrower_text: "Tell us whose account this is." },
  DU_PREFLIGHT_NOTHING_TO_UNDERWRITE: { owner: "32.x", clears: "a missing subject loan, borrower, subject property or credit reference — the 32.x card that collects it (property address, co-borrower, credit consent); 23.1 refuses a missing report first", borrower_text: "We need a little more about the property or the people on this loan before we can run it." },
  DU_PREFLIGHT_DUPLICATE_ASSET: { owner: "22.4", clears: "the joint-account double count — 22.4's reconciliation merges the two statements into one asset with two owners; not an emission tweak", borrower_text: "It looks like the same account was added twice. We will count it once." },
  DU_PREFLIGHT_EMPLOYER_ARC: { owner: "32.x", clears: "wage income with no employer, or an employer arc on non-wage income — the 32.x employment card collects the employer (22.x income source)", borrower_text: "Tell us which employer this income comes from." },
  DU_PREFLIGHT_CASEFILE_ID: { owner: "23.1", clears: "the casefile identifier on the wire disagrees with the submission number or with applications.du_casefile_id — 23.1's ingest writes DU's identifier once; a different one is a DU_CASEFILE_ID_CONFLICT escalation to fnma_portal_operator", borrower_text: null },
};

// ───────── guardrails ─────────
const NO_WAIVER = never("DU_PREFLIGHT_NO_WAIVER", "23.7 AI agent design: no bypass exists — there is no `officer` waiver for a preflight refusal, because every refusal is a document DU would reject", (i) => i["waive"] === true || i["waiver"] !== undefined || i["override"] === true || i["bypass"] === true || i["force"] === true, "a preflight refusal cannot be waived by any role; the document is fixed at its source and re-emitted");
const NO_EDIT = never("DU_PREFLIGHT_NO_EDIT", "23.7 AI agent design: never edits the document to make a check pass", (i) => i["edits"] !== undefined || i["patch"] !== undefined || i["fix_document"] === true || i["drop_arc"] !== undefined || i["remove_container"] !== undefined, "a refusal is cleared at its source (23.2 condition, 32.x card, 22.4 reconciliation) and the document re-emitted from the graph");
const NO_TRANSMIT = never("DU_PREFLIGHT_NO_TRANSMIT", "23.7 AI agent design: never transmits a refused document (23.1's submit evaluates the gate; 23.7-T10)", (i) => i["transmit"] === true || i["submit"] === true || i["send"] === true, "transmission is 23.1's submitCasefile, which refuses while SM_DU_PREFLIGHT_GATE is held");

export const TOOLS_23_7: readonly ToolDef[] = defineTools(PROCESS_23_7, "underwriter", [
  { name: "runDuPreflight", kind: "act", ruleSetVersion: DU_PREFLIGHT_RULE_SET, guardrails: [NO_WAIVER, NO_EDIT, NO_TRANSMIT],
    handler: compute(async (i, ctx, rt) => {
      const cf = casefileIn(i, rt);
      const db = dbOf(rt);
      let xml: string; let du_document_id: string | null; let document_id: string | null; let sha256: string | null; let application_id: string; let submission_number: number;
      if (typeof i["xml"] === "string" && i["xml"]) {
        // A runtime without a database (or a caller holding the bytes): the checks run; nothing persists; the events carry no du_documents id.
        need(i, "submission_number");
        xml = i["xml"]; du_document_id = str(i, "du_document_id") || null; document_id = str(i, "document_id") || null; sha256 = str(i, "sha256") || null;
        application_id = str(i, "application_id") || ctx.applicationId || String((cf as unknown as P)["application_id"] ?? ""); submission_number = Number(i["submission_number"]);
      } else {
        if (!db) throw new PortUnavailable("service:db");
        const by = { du_document_id: str(i, "du_document_id") || null, document_id: str(i, "document_id") || null, application_id: str(i, "application_id") || ctx.applicationId || null };
        if (!by.du_document_id && !by.document_id && !by.application_id) throw new RangeError("runDuPreflight needs xml, du_document_id, document_id or application_id");
        const row = await readDuDocument(db, by);
        if (!row) throw new RangeError(`no du_documents row for ${JSON.stringify(by)}`);
        xml = row.xml; du_document_id = row.du_document_id; document_id = row.document_id; sha256 = row.sha256; application_id = row.application_id; submission_number = row.submission_number;
      }
      const du_casefile_id = typeof i["du_casefile_id"] === "string" ? i["du_casefile_id"] : db && isUuid(application_id) ? ((await db.query<{ du_casefile_id: string | null }>(`SELECT du_casefile_id FROM applications WHERE id = $1`, [application_id]))[0]?.du_casefile_id ?? null) : null;
      const submission_type = (str(i, "submission_type") || "credit_and_underwriting") as SubmissionType;
      const result = runDuPreflight(xml, { du_casefile_id }, cf, { submission_number, submission_type });
      const pf = { application_id, du_document_id: du_document_id ?? "", document_id, sha256, casefile_id: cf.casefile_id, submission_number, result, ran_at: ctx.now, actor: ctx.actor };
      const defer = rt.services["deferWrite"] as ((fn: (q: Queryable) => Promise<void>) => void) | undefined;
      const persisted = Boolean(defer && du_document_id && isUuid(du_document_id) && isUuid(application_id));
      if (persisted) defer!(async (q) => { await persistDuPreflight(q, pf); });
      const event = emitDuPreflight(ctx.events, pf);
      return { application_id, casefile_id: cf.casefile_id, du_document_id, document_id, sha256, submission_number, passed: result.passed, gate: result.passed ? "open" : "held", refusal: result.refusal, checks: result.checks, check_count: result.checks.length, rule_set_version: result.rule_set_version, event: event.type, persisted, transmitted: false,
        route: result.refusal ? DU_REFUSAL_ROUTES[result.refusal.code] : null };
    }),
    decision: (_i, output) => { const o = (output ?? {}) as P; return { action: "runDuPreflight", subject: { kind: "du_documents", id: String(o["du_document_id"] ?? o["document_id"] ?? "") }, ruleCode: o["passed"] ? "23.7" : String((o["refusal"] as P | null)?.["code"] ?? "23.7"), evidenceDocumentIds: o["document_id"] ? [String(o["document_id"])] : [],
      rationale: JSON.stringify({ document_id: o["du_document_id"], passed: o["passed"], checks: o["checks"], rule_set_version: DU_PREFLIGHT_RULE_SET }) }; } },

  { name: "readDuPreflight", kind: "read", handler: compute(async (i, ctx, rt) => {
    const db = dbOf(rt); if (!db) throw new PortUnavailable("service:db");
    const by = { du_document_id: str(i, "du_document_id") || null, document_id: str(i, "document_id") || null, application_id: str(i, "application_id") || ctx.applicationId || null };
    if (!by.du_document_id && !by.document_id && !by.application_id) throw new RangeError("readDuPreflight needs du_document_id, document_id or application_id");
    const row = await readDuPreflightRow(db, by);
    if (!row) throw new RangeError(`no du_preflight_results row for ${JSON.stringify(by)}`);
    const first = row.checks.find((c) => !c.passed) ?? null;
    return { ...row, gate: row.passed ? "open" : "held", refusal: first ? { code: first.code, xpath: first.xpath ?? null, rule: DU_PREFLIGHT_RULES[first.code], detail: first.detail ?? null } : null, check_order: DU_PREFLIGHT_CODES };
  }) },

  { name: "explainDuRefusal", kind: "read", guardrails: [NO_WAIVER], handler: compute((i) => {
    need(i, "code");
    const code = str(i, "code") as PreflightCode;
    const route = DU_REFUSAL_ROUTES[code];
    if (!route) throw new RangeError(`explainDuRefusal: ${code} is not a preflight code (${DU_PREFLIGHT_CODES.join(", ")})`);
    return { code, rule: DU_PREFLIGHT_RULES[code], xpath: str(i, "xpath") || null, owner: route.owner, clears: route.clears, borrower_text: route.borrower_text, du_words_to_borrower: false, waivable: false, transmit: false };
  }) },
]);
