/**
 * §23.6 process-owned tools — the `underwriter` agent's four tools over the DU Specification document
 * (spec/sections/23-desktop-underwriter-and-the-credit-decision/23-6-*.md "AI agent design"), defined with
 * `defineTools("23.6", "underwriter", defs)` and spread by ./index.ts. Every tool string is one spec/registry/agents.json
 * names for 23.6; src/app/tools.test.ts refuses the rest.
 *
 *   assembleDuDocument               act   the 23.5 graph (du/emit.ts loadGraph) with 23.1's snapshot laid over it → the MISMO 3.4 B324 document, persisted
 *                                          as documents + du_documents inside the command's transaction, `du.document.emitted`; a refusal (DU_ENUM_NOT_SUPPORTED,
 *                                          DU_REQUIRED_MISSING, DU_LENGTH, DU_CHILD_NOT_IN_ORDER …) is `du.document.refused{code, path}` and NO row (T4, T5)
 *   validateDuDocumentAgainstSchema  read  xmllint against the vendored DU_Wrapper_3.4.0_B324.xsd chain (src/infra/integrations/du-schema) — a lint, never the gate
 *   diffDuDocumentAgainstSample      read  the golden diff (du/xml.ts diffDuDocument): a document against one of the eighteen samples, container by container, arc by arc
 *   readDuDocument                   read  a du_documents row with its bytes — Fannie Mae-confidential, never borrower-deliverable
 *
 * Guardrails encode the paragraph: the agent cannot write to `documents` except through assembleDuDocument (bytes are never
 * an input — DU_DOCUMENT_HAND_EDITED); it never fills a required data point with a default (DU_DEFAULT_FILL); it never
 * emits a disputed arc (DU_ARC_DISPUTED — the emitter skips them; a caller choosing an endpoint is refused); a document is
 * never handed to a borrower (DU_DOCUMENT_NOT_BORROWER_FACING). Decision record: {application_id, casefile_id,
 * submission_number, sha256, spec_version, container_count, relationship_count, rule_set_version, model_version: null}
 * — no model is involved in assembly.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { defineTools, compute, never, str, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { isUuid, type Queryable } from "../../infra/db/client.ts";
import { samplePaths, xmllintErrors } from "../../infra/integrations/du-schema/index.ts";
import { assembleDuDocument, DU_MISMO_BUILD, DU_SPEC_VERSION, DuEmitError, emptyGraph, loadGraph, withDeal, type DuDocument, type DuGraph } from "../../domain/underwriting/du/emit.ts";
import { diffDuDocument } from "../../domain/underwriting/du/xml.ts";
import { emitDuDocumentEmitted, emitDuDocumentRefused, persistDuDocument, readDuDocument as readDuDocumentRow } from "../../domain/underwriting/du/persist.ts";
import { dealFromSnapshot, type DuCasefile, type SubmissionType } from "../../domain/underwriting/ops-23-1.ts";
import { casefileIn, snapshotIn } from "./section23-1.ts";

export const PROCESS_23_6 = "23.6";
const RULE_SET = "23.6@du-document.v1";
type P = Record<string, unknown>;

const dbOf = (rt: ToolRuntime): Queryable | undefined => rt.services["db"] as Queryable | undefined;
const need = (i: ToolInput, ...keys: string[]): void => { const missing = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (missing.length) throw new RangeError(`23.6 tool needs ${missing.join(", ")}`); };
/** The document's bytes from the input (`xml`) or from a persisted row (`du_document_id` / `document_id` / the application's latest). */
async function xmlIn(i: ToolInput, rt: ToolRuntime, ctx: CommandContext): Promise<{ xml: string; source: string }> {
  if (typeof i["xml"] === "string" && i["xml"]) return { xml: i["xml"], source: "input" };
  const db = dbOf(rt); if (!db) throw new PortUnavailable("service:db");
  const by = { du_document_id: str(i, "du_document_id") || null, document_id: str(i, "document_id") || null, application_id: str(i, "application_id") || ctx.applicationId || null };
  if (!by.du_document_id && !by.document_id && !by.application_id) throw new RangeError("23.6 tool needs xml, du_document_id, document_id or application_id");
  const row = await readDuDocumentRow(db, by);
  if (!row) throw new RangeError(`no du_documents row for ${JSON.stringify(by)}`);
  return { xml: row.xml, source: row.du_document_id };
}
const withTempFile = <T>(xml: string, fn: (file: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "du-doc-"));
  try { const file = join(dir, "document.xml"); writeFileSync(file, xml); return fn(file); } finally { rmSync(dir, { recursive: true, force: true }); }
};

// ───────── guardrails ─────────
const HAND_EDITED = never("DU_DOCUMENT_HAND_EDITED", "23.6 AI agent design: the agent never edits a document by hand and cannot write to `documents` except through assembleDuDocument", (i) => i["xml"] !== undefined || i["bytes"] !== undefined || i["xml_document"] !== undefined || i["document"] !== undefined, "a document is assembled from the 23.5 graph; bytes are never an input to assembly");
const NO_DEFAULT_FILL = never("DU_DEFAULT_FILL", "23.6 AI agent design / rule 4: never fills a required data point with a default — an absent value is a refusal naming the XPath", (i) => i["defaults"] !== undefined || i["fill_defaults"] === true || i["fill_missing"] === true, "a missing required point is refused (or reported to 23.7's gate), never defaulted");
const NO_DISPUTED = never("DU_ARC_DISPUTED", "23.6 rule 1 / 23.5 Open question 2: the two disputed UNDERWRITING_VERIFICATION_* arcs are never emitted; nobody downstream picks a winner", (i) => i["emit_disputed"] === true || i["disputed_endpoint"] !== undefined || i["endpoint"] !== undefined, "the emitter skips a disputed arc and counts it; a caller choosing an endpoint is refused");
const NOT_BORROWER_FACING = never("DU_DOCUMENT_NOT_BORROWER_FACING", "23.6 Outputs: the document is Fannie Mae-confidential; never borrower-deliverable", (i) => i["deliver_to_borrower"] === true || i["recipient"] === "borrower" || i["channel"] === "borrower_portal", "a DU Specification document is never delivered to the borrower");

export const TOOLS_23_6: readonly ToolDef[] = defineTools(PROCESS_23_6, "underwriter", [
  { name: "assembleDuDocument", kind: "act", ruleSetVersion: RULE_SET, guardrails: [HAND_EDITED, NO_DEFAULT_FILL, NO_DISPUTED],
    handler: compute(async (i, ctx, rt) => {
      const cf: DuCasefile = casefileIn(i, rt);
      const application_id = cf.application_id;
      const submission_number = i["submission_number"] === undefined || i["submission_number"] === null ? (cf.submission_count || 0) + 1 : Number(i["submission_number"]);
      const submission_type = (str(i, "submission_type") || "credit_and_underwriting") as SubmissionType;
      const emitted_at = ctx.now;
      const db = dbOf(rt);
      let graph: DuGraph = db && isUuid(application_id) ? await loadGraph(db, application_id) : emptyGraph(application_id);
      // The subject loan's terms and the collateral are 23.1's snapshot's (23.6 Inputs); with none given the LOAN is absent and rule 4 says so.
      if (i["snapshot"] && typeof i["snapshot"] === "object") graph = withDeal(graph, dealFromSnapshot(snapshotIn(i), cf.system_id_ref));
      const conditionality = i["conditionality"] === "report" ? "report" : "refuse";
      let document: DuDocument;
      try {
        document = assembleDuDocument(graph, { casefile_id: cf.casefile_id, seller_number: cf.seller_number, system_id_ref: cf.system_id_ref }, { submission_number, submission_type }, { conditionality });
      } catch (e) {
        if (e instanceof DuEmitError) emitDuDocumentRefused(ctx.events, { application_id, casefile_id: cf.casefile_id, submission_number, error: e, at: emitted_at }, ctx.actor);
        throw e;
      }
      const document_id = str(i, "document_id") || randomUUID(); const du_document_id = randomUUID();
      const row = { application_id, casefile_id: cf.casefile_id, submission_number, submission_id: str(i, "submission_id") || null, document, document_id, du_document_id, emitted_at };
      const defer = rt.services["deferWrite"] as ((fn: (q: Queryable) => Promise<void>) => void) | undefined;
      const persisted = Boolean(defer && isUuid(application_id));
      if (persisted) defer!(async (q) => { await persistDuDocument(q, row); });
      emitDuDocumentEmitted(ctx.events, row, ctx.actor);
      return { application_id, casefile_id: cf.casefile_id, submission_number, document_id, du_document_id, sha256: document.sha256, spec_version: DU_SPEC_VERSION, mismo_build: DU_MISMO_BUILD, container_count: document.stats.container_count, relationship_count: document.stats.relationship_count, borrower_count: document.stats.borrower_count, disputed_arcs_skipped: document.stats.disputed_arcs_skipped, required_missing: document.gaps.length, gaps: document.gaps, byte_size: document.bytes.byteLength, persisted, xml_document: new TextDecoder().decode(document.bytes) };
    }),
    decision: (_i, output) => { const o = (output ?? {}) as P; return { action: "assembleDuDocument", subject: { kind: "du_documents", id: String(o["du_document_id"] ?? "") }, ruleCode: "23.6", evidenceDocumentIds: o["document_id"] ? [String(o["document_id"])] : [],
      rationale: JSON.stringify({ application_id: o["application_id"], casefile_id: o["casefile_id"], submission_number: o["submission_number"], sha256: o["sha256"], spec_version: o["spec_version"], container_count: o["container_count"], relationship_count: o["relationship_count"], rule_set_version: RULE_SET, model_version: null }) }; } },

  { name: "validateDuDocumentAgainstSchema", kind: "read", handler: compute(async (i, ctx, rt) => {
    const { xml, source } = await xmlIn(i, rt, ctx);
    const errors = withTempFile(xml, xmllintErrors);
    return { valid: errors.length === 0, errors, source, schema: "DU_Wrapper_3.4.0_B324.xsd", note: "schema validity is necessary and nowhere near sufficient (23.6 Verified requirement): a dangling xlink:to, a duplicate label, an invented arcrole, five borrowers all validate — 23.7's preflight is the gate" };
  }) },

  { name: "diffDuDocumentAgainstSample", kind: "read", handler: compute(async (i, ctx, rt) => {
    need(i, "sample");
    const name = str(i, "sample");
    const matches = samplePaths().filter((p) => basename(p).startsWith(`${name}_`) || basename(p) === name);
    if (matches.length !== 1) throw new RangeError(`${matches.length} samples match ${JSON.stringify(name)}; name one of the eighteen by its prefix (DI-C09)`);
    const { xml, source } = await xmlIn(i, rt, ctx);
    const d = diffDuDocument(xml, readFileSync(matches[0]!, "utf8"));
    return { sample: basename(matches[0]!), source, equal: d.equal, xpath: d.xpath ?? null, detail: d.detail ?? null, labels: Object.fromEntries(d.labels) };
  }) },

  { name: "readDuDocument", kind: "read", guardrails: [NOT_BORROWER_FACING], handler: compute(async (i, ctx, rt) => {
    const db = dbOf(rt); if (!db) throw new PortUnavailable("service:db");
    const by = { du_document_id: str(i, "du_document_id") || null, document_id: str(i, "document_id") || null, application_id: str(i, "application_id") || ctx.applicationId || null };
    if (!by.du_document_id && !by.document_id && !by.application_id) throw new RangeError("readDuDocument needs du_document_id, document_id or application_id");
    const row = await readDuDocumentRow(db, by);
    if (!row) throw new RangeError(`no du_documents row for ${JSON.stringify(by)}`);
    return { ...row, borrower_deliverable: false, confidential_to: "fannie_mae" };
  }) },
]);
