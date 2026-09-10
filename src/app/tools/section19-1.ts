/**
 * §19.1 tools — the spec's tool strings for process 19.1, verbatim, via
 * `defineTools("19.1", "<agent>", defs)` from ../tools.ts (see section13.ts). Spread by ./section19.ts.
 *
 * `records.classify` maps a record type to every applicable retention class (effective = max, rule 1);
 * `records.compileServicingFile` builds the §1024.38(c)(2)(i)–(v) bundle of rule 5 from the systems of
 * record (ledger entries joined to payments/allocations/suspense/escrow lines/disbursements with running
 * balances as CSV + print pages; the latest security instrument and recorded modifications; contacts, case
 * notes and agent rationales; the data-field report over loans/loan_terms/borrowers/properties/escrow with
 * SSNs redacted; borrower submissions of the §1024.35/§1024.41 procedures), stores the bundle as a
 * `documents` row, writes the `servicing_file_snapshots` row with its `bundle_document_id` and emits
 * `servicing_file.compiled` (satisfies REGX_1024_38C2_SERVICING_FILE_5D and, on the 25th compile of a
 * drill whose every compile stayed within target, SM_SERVICING_FILE_DRILL_MONTHLY). Its `compile_ms` is the
 * handler's own elapsed wall-clock (rule 5 "≤5 minutes wall-clock") — never a value the caller asserts.
 *
 * Guardrails encode the agent paragraph and bind to the facts, not to caller flags: the agent can
 * never delete; disposal executes only through a run whose officer attestation (`disposal_run.attested`
 * by a human officer) and WORM verification (`worm_integrity.checked{run_halted=false}`) are events in
 * the log; holds are never auto-released; a delivery (`op=deliver` for a `request_id`) is refused unless
 * the log holds the request's own `records.request.received` with a verified authority confidence ≥ 0.85,
 * the attorney approval a subpoena needs, the officer sign-off a Fannie Mae/regulator production needs and
 * the officer confirmation a >500-loan or new-requester scope needs — each a `records.request.approved`
 * by a human of that role, whoever calls the tool. The lifecycle-engine commands in
 * src/domain/data-security/ops-19-1.ts apply the same `disposalGuards` / `productionGuards` from the same
 * events, so the ops-console human path is held to identical rules when AI is off (T15).
 */
import { defineTools, compute, never, guard, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { Guardrail } from "../commands.ts";
import type { CommandContext } from "../commands.ts";
import { classifyRecord, compileServicingFile, disposalGuards, attestationFromEvents, wormFromEvents, productionGuards, DRILL_SAMPLE_SIZE, SERVICING_FILE_TARGET_MS, BORROWER_SUBMISSION_CASE_TYPES, type ProductionCode, type Row } from "../../domain/data-security/ops-19-1.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const AGENT = "security-records";
const rows = (rt: ToolRuntime, kind: string, loanId: string, where: (d: Row) => boolean = () => true): Row[] => rt.store.list(kind, (d) => d.loan_id === loanId && where(d)).map((r) => ({ id: r.id, ...r.data }));
const isDelivery = (i: ToolInput): boolean => i.op === "deliver" || flag(i, "deliver");
/** The delivery decision the domain makes over the same log; one guard per sentence of the agent paragraph refuses on its own code. */
const deliveryRail = (code: string, citation: string, codes: readonly ProductionCode[]): Guardrail<ToolInput> =>
  guard(code, citation, (i, ctx) => { if (!isDelivery(i)) return undefined; const d = productionGuards({ op: "deliver", request_id: str(i, "request_id") || null, log: ctx.events.all() }); return d.code !== null && codes.includes(d.code) ? `${d.code}: ${d.citation}` : undefined; });

/** The agent-paragraph guardrails, shared by every 19.1 tool (and by the human path): the disposal and delivery facts come from the event log the command context carries. */
export const GUARDRAILS_19_1: readonly Guardrail<ToolInput>[] = [
  never("NO_DELETE", "19.1 guardrails: the agent can never delete", (i) => i.op === "delete" || flag(i, "delete"), "records are disposed only by an attested disposal run — never deleted by a tool"),
  guard("DISPOSAL_ONLY_VIA_ATTESTED_RUN", "19.1 guardrails: disposal executes only through the attested run (rule 7: officer attestation before execution; integrations: WORM copy verified first)", (i, ctx) => {
    if (i.op !== "dispose") return undefined;
    const runId = str(i, "disposal_run_id") || null;
    const log = ctx.events.all();
    const d = disposalGuards({ op: "dispose", actor: ctx.actor, disposal_run_id: runId, attestation: runId ? attestationFromEvents(log, runId) : null, worm: runId ? wormFromEvents(log, runId) : null, object_id: str(i, "object_id") || null });
    return d.allowed ? undefined : `${d.code}: ${d.citation}`;
  }),
  never("NO_AUTO_HOLD_RELEASE", "19.1 guardrails: holds are never auto-released (POL-REC-02: officer + attorney jointly, a human act outside the agent tools)", (i) => i.op === "release_hold" || flag(i, "release_hold"), "hold release is a human act by officer and attorney"),
  deliveryRail("AUTHORITY_CONFIDENCE_BELOW_0_85", "19.1 guardrails: confidence < 0.85 on requester authority → escalate", ["AUTHORITY_CONFIDENCE_BELOW_0_85"]),
  deliveryRail("OFFICER_CONFIRM_LARGE_OR_NEW_REQUESTER", "19.1 guardrails: any request scope > 500 loans or any request from a new requester identity requires officer confirmation before delivery", ["OFFICER_CONFIRMATION_REQUIRED"]),
  deliveryRail("PRODUCTION_APPROVAL_REQUIRED", "19.1 escalations / T14: subpoena or court order → attorney approval; Fannie Mae and regulator productions → officer sign-off; no production is delivered without them", ["ATTORNEY_APPROVAL_REQUIRED", "OFFICER_SIGN_OFF_REQUIRED"]),
];

/** The latest row by `version` / effective date — "loan_terms (current version)". */
const current = (list: readonly Row[]): Row | null => (list.length ? [...list].sort((a, b) => Number(a.version ?? 0) - Number(b.version ?? 0) || String(a.effective_from ?? "").localeCompare(String(b.effective_from ?? "")))[list.length - 1]! : null);
const latest = (list: readonly Row[], key: string): Row | null => (list.length ? [...list].sort((a, b) => String(a[key] ?? "").localeCompare(String(b[key] ?? "")))[list.length - 1]! : null);

/** Rule 5: gather (i)–(v) from the systems of record for one loan. */
function gather(rt: ToolRuntime, loanId: string): { loan: Row; sources: Omit<Parameters<typeof compileServicingFile>[0], "compile_ms" | "compiled_at" | "requested_by" | "borrower_submitted_not_applicable_reason">; v_not_applicable_reason: string | null } {
  const loanRec = rt.store.get("loans", loanId);
  if (!loanRec) throw new RangeError(`no loans row for ${loanId}: a servicing file is compiled from the system of record`);
  const loan: Row = { id: loanRec.id, ...loanRec.data };
  const documents = rows(rt, "documents", loanId);
  const isSi = (d: Row) => d.type === "security_instrument" || d.kind === "security_instrument";
  const isMod = (d: Row) => (d.type === "security_instrument_modification" || d.kind === "security_instrument_modification" || d.type === "modification_agreement") && (d.recorded === true || !!d.recorded_on);
  const links = rt.store.list("loan_borrowers", (d) => d.loan_id === loanId).map((r) => String(r.data.borrower_id ?? ""));
  const borrowers = links.length ? links.map((id) => rt.store.get("borrowers", id)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => ({ id: r.id, ...r.data })) : rows(rt, "borrowers", loanId);
  const property = rt.store.get("properties", loanId);
  const properties = [...(property ? [{ id: property.id, ...property.data }] : []), ...rows(rt, "properties", loanId)];
  const delinquency = rt.store.get("delinquency_counters", loanId);
  const cases = rows(rt, "cases", loanId, (d) => (BORROWER_SUBMISSION_CASE_TYPES as readonly string[]).includes(String(d.case_type ?? d.kind ?? "")));
  return {
    loan,
    sources: {
      loan_id: loanId,
      transactions: { ledger_entries: rows(rt, "ledger_entries", loanId), payments: rows(rt, "payments", loanId), payment_allocations: rows(rt, "payment_allocations", loanId), suspense_items: rows(rt, "suspense_items", loanId), escrow_lines: rows(rt, "escrow_lines", loanId), disbursements: rows(rt, "disbursements", loanId) },
      security_instrument: latest(documents.filter(isSi), "recorded_on"), recorded_modifications: documents.filter(isMod),
      personnel_notes: { contacts: rows(rt, "contacts", loanId), case_notes: rows(rt, "case_notes", loanId), agent_decisions: rows(rt, "agent_decisions", loanId) },
      data_fields: { loans: loan, loan_terms: current(rows(rt, "loan_terms", loanId)), borrowers, properties, escrow_accounts: rows(rt, "escrow_accounts", loanId), escrow_lines: rows(rt, "escrow_lines", loanId), delinquency: delinquency ? { id: delinquency.id, ...delinquency.data } : null },
      documents,
    },
    // (v) "not applicable" is a fact of the case register, documented on the bundle: no §1024.35 / §1024.41 procedure was ever opened on the loan
    v_not_applicable_reason: cases.length ? null : `no §1024.35 / §1024.41 case (${BORROWER_SUBMISSION_CASE_TYPES.join(", ")}) on loan ${loanId}: no borrower-submitted documents exist`,
  };
}

export const TOOLS_19_1: readonly ToolDef[] = defineTools("19.1", AGENT, [
  { name: "records.classify", kind: "read", guardrails: GUARDRAILS_19_1, handler: compute((i) => { need(i, "record_type"); return classifyRecord(str(i, "record_type"), str(i, "state") || null, { fdcpa_debt_collector: typeof i.fdcpa_debt_collector === "boolean" ? i.fdcpa_debt_collector : null, regz_disclosure: typeof i.regz_disclosure === "boolean" ? i.regz_disclosure : null }); }) },
  { name: "records.compileServicingFile", kind: "act", guardrails: GUARDRAILS_19_1,
    handler: compute((i, ctx: CommandContext, rt) => {
      const t0 = performance.now();   // rule 5: ≤5 minutes wall-clock — the handler's own elapsed time, never a caller-supplied figure
      need(i, "loan_id");
      const loanId = str(i, "loan_id");
      const g = gather(rt, loanId);
      const requestedBy = str(i, "requested_by") || "drill";
      const drillId = requestedBy === "drill" ? (str(i, "drill_id") || `DRILL-${ctx.now.slice(0, 7)}`) : null;
      const bundle = compileServicingFile({ ...g.sources, borrower_submitted_not_applicable_reason: str(i, "v_not_applicable_reason") || g.v_not_applicable_reason, compiled_at: ctx.now, requested_by: requestedBy, compile_ms: Math.round(performance.now() - t0) });
      // the drill tags (timer row "×25 within 5 minutes each"): this compile's ordinal in the drill and whether every compile of the drill, this one included, stayed within target — from the log, not from the caller
      const prior = drillId ? ctx.events.all().filter((e) => e.type === "servicing_file.compiled" && e.payload.requested_by === "drill" && e.payload.drill_id === drillId) : [];
      const drill = drillId ? { drill_id: drillId, drill_index: prior.length + 1, drill_sample: DRILL_SAMPLE_SIZE, drill_all_within_target: bundle.within_target && prior.every((e) => e.payload.within_target === true) } : {};
      const doc = rt.store.put("documents", `doc-sfs-${loanId}-${ctx.now}`, { loan_id: loanId, type: "servicing_file_bundle", record_type: "servicing_file_bundle", source: "servicer", sha256: bundle.sha256, formats: bundle.formats, compiled_at: ctx.now, requested_by: requestedBy, sections: bundle.sections, bundle }, ctx.actor, ctx.now);
      const snap = rt.store.put("servicing_file_snapshots", `sfs-${loanId}-${ctx.now}`, { loan_id: loanId, compiled_at: ctx.now, compile_ms: bundle.compile_ms, bundle_document_id: doc.id, sha256: bundle.sha256, sections: bundle.sections, requested_by: requestedBy, within_target: bundle.within_target, target_ms: SERVICING_FILE_TARGET_MS, gaps: bundle.gaps, ...drill }, ctx.actor, ctx.now);
      ctx.events.append({ type: "servicing_file.compiled", loanId, actor: ctx.actor, payload: { snapshot_id: snap.id, bundle_document_id: doc.id, sha256: bundle.sha256, compile_ms: bundle.compile_ms, within_target: bundle.within_target, sections: bundle.sections, requested_by: requestedBy, gaps: bundle.gaps, ...drill } });
      return { snapshot_id: snap.id, bundle_document_id: doc.id, ...drill, ...bundle };
    }) },
]);
