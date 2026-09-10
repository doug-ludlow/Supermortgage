/**
 * §18.3 tools — the spec's tool strings for process 18.3, verbatim, via
 * `defineTools("18.3", "<agent>", defs)` from ../tools.ts (see section13.ts). Spread by ./section18.ts.
 *
 * spec/registry/agents.json lists no tool strings for 18.3 (`tools: []`; the spec's prose "SQL over projections,
 * config registry, document parser, report renderer, `human_portal_task.create`, partner delivery" was not extracted as
 * tool names), and src/app/tools.test.ts refuses any bus tool the registry does not name for its process — so the bus
 * carries none. The three guardrail sentences of the Agents paragraph are encoded here in bus shape (never / needsRole
 * over the §18.3 domain gates in src/domain/qc-audit/ops-18-3.ts) so they attach unchanged once the registry names the
 * tools; src/domain/qc-audit/18-3.spec.test.ts exercises them.
 */
import { never, needsRole, str, flag, type ToolDef, type ToolInput } from "../tools.ts";
import type { Guardrail } from "../commands.ts";
import { delinquencyHistoryWriteGate, fnmaErrorInquiryGate, confidentialityGate, independentEvidenceSources, FNMA_ERROR_GUARDRAIL_CITATION, STAR_CONFIDENTIALITY_CITATION, type StarAudience, type StarDocumentKind } from "../../domain/qc-audit/ops-18-3.ts";

const refs = (i: ToolInput): string[] => (Array.isArray(i.evidence_refs) ? (i.evidence_refs as unknown[]).map(String) : []);
const audience = (i: ToolInput): StarAudience => (str(i, "audience") || "vendor") as StarAudience;
const kind = (i: ToolInput): StarDocumentKind => (str(i, "kind") || "distribution_list") as StarDocumentKind;

/** §18.3 guardrails: "never alter delinquency history to match a scorecard; classification "Fannie Mae error" requires two independent evidence refs and `officer` sign-off before any inquiry is sent; confidentiality filter on report distribution lists." */
export const GUARDRAILS_18_3: Readonly<Record<"noDelinquencyHistoryRewrite" | "fnmaErrorEvidenceRefs" | "fnmaErrorOfficerSignoff" | "confidentialityFilter", Guardrail<ToolInput>>> = {
  // SQL over projections: reads `loan_delinquency_months`; a write to it (however justified by a scorecard) is refused for every actor
  noDelinquencyHistoryRewrite: never("NO_DELINQUENCY_HISTORY_REWRITE", "§18.3 guardrails: never alter delinquency history to match a scorecard",
    (i) => !delinquencyHistoryWriteGate({ target: str(i, "target"), op: i.op === "write" ? "write" : "read" }).allowed,
    "classify the variance (reporting timing / definition mismatch / data defect → 18.1 / Fannie Mae error) instead of editing delinquency history"),
  // report renderer / STAR-mailbox inquiry: a "Fannie Mae error" inquiry needs two independent evidence refs …
  fnmaErrorEvidenceRefs: never("FNMA_ERROR_EVIDENCE_REFS", FNMA_ERROR_GUARDRAIL_CITATION,
    (i) => str(i, "classification") === "fnma_error" && flag(i, "send") && independentEvidenceSources(refs(i)).length < 2,
    "two independent evidence refs are required before a Fannie Mae error inquiry is sent"),
  // … and `officer` sign-off — the send is an officer act (agents escalate)
  fnmaErrorOfficerSignoff: needsRole("FNMA_ERROR_OFFICER_SIGNOFF", FNMA_ERROR_GUARDRAIL_CITATION,
    (i) => str(i, "classification") === "fnma_error" && flag(i, "send") && !fnmaErrorInquiryGate({ classification: "fnma_error", evidence_refs: refs(i), officer_signoff: null }).allowed,
    ["officer"], "a Fannie Mae error inquiry is sent only with officer sign-off"),
  // partner delivery / distribution lists: a report classified `carries_star_data` (or whose text cites STAR results) never reaches vendors or marketing; the partner only under the confidentiality clause
  confidentialityFilter: never("STAR_CONFIDENTIALITY", STAR_CONFIDENTIALITY_CITATION,
    (i) => !confidentialityGate({ audience: audience(i), kind: kind(i), text: str(i, "text"), carries_star_data: flag(i, "carries_star_data"), partner_confidentiality_clause: flag(i, "partner_confidentiality_clause"), fnma_marketing_package: flag(i, "fnma_marketing_package") }).allowed,
    "STAR Scorecard results are confidential — drop the third-party recipient (or attach the partner confidentiality clause)"),
};

export const TOOLS_18_3: readonly ToolDef[] = [];
