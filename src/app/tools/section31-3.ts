/**
 * §31.3 process-owned tools — bus tools for 31.3 defined with `defineTools("31.3", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 31.3; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The `security-records` agent (shared with 19.x) runs in application scope. `records.classify` maps an origination
 * record type to every applicable class (rule 1: the type's own federal/state classes plus the Fannie Mae class once
 * `loan.funded`, or the Reg B policy class for a file that never funds) and, with `op=enroll`, enrols the write as a
 * record object (`record.enrolled{record_type}`; the §1024.14(h) Section 8 types arm RESPA_1024_14H_S8_RETENTION_5Y).
 * `records.anchor` reads one platform event (21.6's action names, 26.2's consummation, 22.6's screening, 28.3's LAR
 * acceptance, 28.4's SAR/OFAC, 19.1's servicing anchors …) into the facts the gates read and emits
 * `record.anchored{class, anchor_at}` per class; with `op=lo_comp_paid` / `op=afba_executed` it records the two 31.3
 * writes that carry their own anchors (`lo_comp.paid`, `afba.executed`); with `op=clocks` it reads a file's clocks
 * (worked examples 1–3) without writing. The rest of the agent paragraph (compileOriginationFile, holds.place,
 * disposal.plan, vendors.checkFlowdown, pii.monitor, scan.fannieDataUse, incident.scope{origination}) lives in
 * src/domain/governance/ops-31-3.ts and the 19.x tools; the same guardrails bind the ops-console human path.
 *
 * Guardrails encode the agent paragraph: never deletes (disposal only through the attested run); never releases a
 * hold; never opens a vendor gate on inference; never sends a regulatory or Fannie Mae notice (drafts only); never
 * reads `applicant_demographics` content into a prompt (ids and hashes only); never re-purposes credit or Fannie Mae data.
 */
import { defineTools, compute, never, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { Guardrail } from "../commands.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { classifyOriginationRecord, enrollRecord, anchorObjects, anchorFromEvent, recordLoCompPaid, recordAfbaExecuted, fileClocks, ciDataUseCheck, ANCHOR_EVENTS, ORIG_RECORD_TYPES, ORIG_RETENTION_CLASSES, type OrigRecordObject, type OrigObjectFacts, type OrigContext } from "../../domain/governance/ops-31-3.ts";

/** Missing-input guard: a tool executed without its subject refuses with a RangeError (never a TypeError). */
const need = (i: ToolInput, ...keys: string[]): void => { const gaps = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (gaps.length) throw new RangeError(`31.3 tool needs ${gaps.join(", ")}`); };
const AGENT = "security-records";
const pd = (i: ToolInput, k: string): PlainDate | null => (typeof i[k] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(i[k] as string) ? D(i[k] as string) : null);
const obj = (i: ToolInput, k: string): Record<string, unknown> | null => (i[k] && typeof i[k] === "object" ? (i[k] as Record<string, unknown>) : null);
const ctxOf = (ctx: CommandContext, rt: ToolRuntime): OrigContext => ({ events: ctx.events, actor: ctx.actor, now: ctx.now, escalations: rt.escalations });
const objectsOf = (i: ToolInput, rt: ToolRuntime, applicationId: string | null): OrigRecordObject[] =>
  Array.isArray(i.objects) ? (i.objects as OrigRecordObject[]) : rt.store.list("record_objects", (d) => applicationId === null || d.application_id === applicationId).map((r) => ({ id: r.id, ...r.data }) as unknown as OrigRecordObject);
const putObjects = (rt: ToolRuntime, ctx: CommandContext, objects: readonly OrigRecordObject[]): void => { for (const o of objects) rt.store.put("record_objects", o.id, o as unknown as Record<string, unknown>, ctx.actor, ctx.now); };

/** The agent-paragraph guardrails, shared by both tools (and by the human path). */
export const GUARDRAILS_31_3: readonly Guardrail<ToolInput>[] = [
  never("NO_DELETE", "31.3 guardrails: never deletes (disposal only through the attested run)", (i) => i.op === "delete" || flag(i, "delete"), "records are disposed only by an officer-attested disposal run (rule 5 / 19.1 rule 7) — never deleted by a tool"),
  never("NO_HOLD_RELEASE", "31.3 guardrails: never releases a hold", (i) => i.op === "release_hold" || flag(i, "release_hold"), "hold release is a human act by officer and attorney (19.1 POL-REC-02)"),
  never("NO_GATE_ON_INFERENCE", "31.3 guardrails: never opens a vendor gate on inference", (i) => i.op === "open_vendor_gate" || flag(i, "inferred"), "a vendor gate opens only on executed contract_clauses (rule 9), never on an inferred clause status"),
  never("DRAFTS_ONLY", "31.3 guardrails: never sends a regulatory or Fannie Mae notice (drafts only)", (i) => i.op === "send_notice" || flag(i, "send"), "regulatory and Fannie Mae incident notices are drafted by the agent and sent by an officer (19.2)"),
  never("NO_DEMOGRAPHICS_IN_PROMPT", "31.3 guardrails: never reads applicant_demographics content into a prompt", (i) => flag(i, "include_content") || flag(i, "include_demographics"), "the custody tools operate on ids and hashes; applicant_demographics content never enters a prompt (rule 8)"),
  never("NO_REPURPOSE_CREDIT_OR_FNMA_DATA", "31.3 guardrails: never re-purposes credit or Fannie Mae data", (i) => { const p = str(i, "pipeline"); const refs = Array.isArray(i.references) ? (i.references as string[]) : []; return p !== "" && !ciDataUseCheck({ dataset: "tool", pipeline: p, references: refs }).passed; }, "credit-report data and Fannie Mae Data are used only for the credit transaction (FCRA §604(f); Technology Guide) — never for analytics, marketing or model training (rule 7)"),
];

export const TOOLS_31_3: readonly ToolDef[] = defineTools("31.3", AGENT, [
  {
    name: "records.classify", kind: "act", guardrails: GUARDRAILS_31_3,
    handler: compute((i, ctx, rt) => {
      if (i.op === "registry") return { retention_classes: ORIG_RETENTION_CLASSES, record_types: ORIG_RECORD_TYPES };
      need(i, "record_type");
      const funded = flag(i, "funded") || flag(i, "fnma_property");
      const classification = classifyOriginationRecord(str(i, "record_type"), { funded, state: str(i, "state") || null, closing_type: str(i, "closing_type") || null });
      if (i.op !== "enroll") return classification;
      need(i, "application_id", "object_id", "sha256");
      const facts = (obj(i, "facts") as OrigObjectFacts | null) ?? { funded };
      const { object, event } = enrollRecord({ id: str(i, "object_id"), record_type: str(i, "record_type"), application_id: str(i, "application_id"), loan_id: str(i, "loan_id") || null, state: str(i, "state") || null, sha256: str(i, "sha256"), facts: { ...facts, funded }, document_date: pd(i, "document_date"), closing_type: str(i, "closing_type") || null }, ctxOf(ctx, rt));
      putObjects(rt, ctx, [object]);
      return { classification, object, event_id: event.id };
    }),
    decision: (i, out) => (i.op === "enroll" ? { action: "records.classify:enroll", rationale: `record ${str(i, "object_id")} (${str(i, "record_type")}) enrolled with classes ${((out as { classification: { retention_class_codes: string[] } }).classification.retention_class_codes).join(", ")}`, subject: { kind: "record_object", id: str(i, "object_id") }, ruleCode: "31.3 rule 1" } : null),
  },
  {
    name: "records.anchor", kind: "act", guardrails: GUARDRAILS_31_3,
    handler: compute((i, ctx, rt) => {
      const c = ctxOf(ctx, rt);
      if (i.op === "anchor_events") return { anchor_events: Object.fromEntries(Object.entries(ANCHOR_EVENTS).map(([k, v]) => [k, { classes: v.classes, note: v.note }])) };
      if (i.op === "clocks") { const facts = obj(i, "facts") as OrigObjectFacts | null; if (!facts) throw new RangeError("31.3 records.anchor op=clocks needs facts"); return fileClocks(facts, pd(i, "today") ?? D(ctx.now.slice(0, 10)), typeof i.hold_count === "number" ? i.hold_count : 0); }
      if (i.op === "lo_comp_paid") { need(i, "application_id", "record_id", "mlo_nmlsr_id", "paid_on", "sha256"); const r = recordLoCompPaid({ application_id: str(i, "application_id"), loan_id: str(i, "loan_id") || null, mlo_nmlsr_id: str(i, "mlo_nmlsr_id"), paid_on: D(str(i, "paid_on")), kind: str(i, "kind") === "received" ? "received" : "paid", record_id: str(i, "record_id"), sha256: str(i, "sha256") }, c); putObjects(rt, ctx, [r.object]); return { event_id: r.event.id, object: r.object }; }
      if (i.op === "afba_executed") { need(i, "application_id", "record_id", "executed_on", "sha256"); const r = recordAfbaExecuted({ application_id: str(i, "application_id"), executed_on: D(str(i, "executed_on")), record_id: str(i, "record_id"), sha256: str(i, "sha256"), provider: str(i, "provider") || "affiliate" }, c); putObjects(rt, ctx, [r.object]); return { event_id: r.event.id, object: r.object }; }
      need(i, "event_type");
      const payload = obj(i, "payload") ?? {};
      const applicationId = str(i, "application_id") || (typeof payload.application_id === "string" ? String(payload.application_id) : "");
      const occurredAt = str(i, "occurred_at") || ctx.now;
      const e = { id: str(i, "event_id") || "", type: str(i, "event_type"), payload: { ...(applicationId ? { application_id: applicationId } : {}), ...payload }, occurredAt, ...(applicationId ? { applicationId } : {}) };
      if (i.op === "read") return anchorFromEvent(e);
      need(i, "application_id");
      const r = anchorObjects(objectsOf(i, rt, applicationId), e, c);
      putObjects(rt, ctx, r.objects);
      return { anchored: r.anchored, result: r.result, event_ids: r.events.map((x) => x.id), objects: r.objects };
    }),
    decision: (i, out) => (i.op === "read" || i.op === "clocks" || i.op === "anchor_events" ? null : { action: `records.anchor:${str(i, "op") || str(i, "event_type")}`, rationale: `anchor ${str(i, "event_type") || str(i, "op")} applied to ${Array.isArray((out as { anchored?: unknown[] }).anchored) ? (out as { anchored: unknown[] }).anchored.length : 1} object(s) of application ${str(i, "application_id")}`, subject: { kind: "application", id: str(i, "application_id") }, ruleCode: "31.3 rule 1 (anchors)" }),
  },
]);
