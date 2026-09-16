/**
 * §35.9 rule 8 — "A firm is an outbox counterparty." `firm.dispatch` writes one `integration_messages` row on the `law-firm`
 * adapter (idempotency `firm:<case_id>:<kind>:<owning_event_id>`, 35.3's drain retry policy) and a `firm_dispatches` row; the
 * drain (35.1's, every sweep) delivers it through the FAKE (`FakeLawFirm`) — the completion hook stamps `sent_at`. The FAKE's
 * replies are a pure function of the dispatch and the day; the daily unit asks for them (`dueFirmReplies`) and `firm.inbound`
 * turns each into the owning section's command with `source: firm` (an inbound `integration_messages` row, direction `in`,
 * keyed by the reply id, is what makes a reply ingest exactly once). On outage the dispatch stays `queued` and the sections'
 * clocks keep running (Integrations).
 */
import type { CommandContext } from "../../../app/commands.ts";
import { PortUnavailable, type ToolInput, type ToolRuntime } from "../../../app/tools.ts";
import type { Queryable } from "../../../infra/db/client.ts";
import { PgOutbox } from "../../../infra/integrations/pg-outbox.ts";
import type { OutboundAdapter, OutboxMessage } from "../../../infra/integrations/outbox.ts";
import type { FirmDispatchMessage, FirmReply, LawFirmPort } from "../../../infra/integrations/legal.ts";
import type { OutboxCompletion } from "../seam/outbox.ts";
import { ENGINE_ACTOR, EV } from "../default-35-9.ts";
import { need, q, s } from "./commands.ts";
import { delegate } from "./delegate.ts";
import { writeExpectation } from "./expectations.ts";
import { caseUuid, currentRow, loanRows, openForeclosure, str, type CurrentRow, type Row } from "./store.ts";

export const LAW_FIRM_ADAPTER = "law-firm";
export type DispatchKind = FirmDispatchMessage["kind"];
export type DispatchRow = { readonly id: string; readonly loan_id: string; readonly case_id: string | null; readonly firm_id: string; readonly kind: DispatchKind; readonly owning_event_id: string | null; readonly integration_message_id: string | null; readonly document_id: string | null; readonly sent_at: string | null; readonly acknowledged_at: string | null; readonly ack_source: string | null; readonly created_at: string };
const SEL = `id::text AS id, loan_id::text AS loan_id, case_id::text AS case_id, firm_id, kind, owning_event_id::text AS owning_event_id, integration_message_id::text AS integration_message_id, document_id::text AS document_id, sent_at::text AS sent_at, acknowledged_at::text AS acknowledged_at, ack_source, created_at::text AS created_at`;

const methodOf = (row: CurrentRow | null): "judicial" | "non_judicial" => (str(row?.data ?? {}, "method") === "non_judicial" ? "non_judicial" : "judicial");
const stateOf = (row: CurrentRow | null): string => (str(row?.data ?? {}, "jurisdiction_state") || str(row?.data ?? {}, "state") || "FL").toUpperCase();

/** The dispatch as the port sees it: the owning event's date is what the FAKE keys its replies to (35.9-T14). */
export async function dispatchMessage(qx: Queryable, d: DispatchRow, payload: Row): Promise<FirmDispatchMessage> {
  const caseRef = String(payload["case_ref"] ?? d.case_id ?? "");
  const fc = caseRef ? await currentRow(qx, "foreclosure_cases", caseRef) : null;
  const ev = d.owning_event_id ? (await qx.query<{ on: string; payload: Row }>(`SELECT occurred_at::text AS on, payload FROM loan_events WHERE id = $1::uuid`, [d.owning_event_id]))[0] : undefined;
  const owningOn = String(ev?.payload["sent_at"] ?? ev?.payload["referral_sent_at"] ?? ev?.payload["occurred_on"] ?? ev?.on ?? d.created_at).slice(0, 10);
  return { dispatch_id: d.id, loan_id: d.loan_id, case_id: d.case_id, firm_id: d.firm_id, kind: d.kind, owning_event_id: d.owning_event_id, owning_event_on: owningOn, state: stateOf(fc), method: methodOf(fc), payload: { ...payload, case_ref: caseRef } };
}

/** `firm.dispatch{case_id, kind, payload, document_id?, owning_event_id?}` — the outbox row and the dispatch row, in the command's transaction. */
export async function firmDispatch(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<Row> {
  need(i, "kind"); const loanId = s(i, "loan_id") || ctx.loanId; need({ loan_id: loanId }, "loan_id");
  const kind = s(i, "kind") as DispatchKind;
  if (!["referral_package", "instruction", "message", "documents", "invoice_response", "status_demand", "ack_demand"].includes(kind)) throw new RangeError(`kind must be referral_package | instruction | message | documents | invoice_response | status_demand | ack_demand`);
  const caseRef = s(i, "case_id");
  const fc = (caseRef ? rt.store.get("foreclosure_cases", caseRef) : undefined) ?? openForeclosure(await loanRows(q(ctx), "foreclosure_cases", loanId));
  const firmId = s(i, "firm_id") || (fc ? str(fc.data, "firm_id") : "");
  if (!firmId) throw new RangeError("firm_id is required (the case names no retained firm)");
  const owningEventId = s(i, "owning_event_id") || null;
  const payload = { ...((i.payload as Row | undefined) ?? {}), case_ref: caseRef || (fc?.id ?? null), kind };
  const caseId = caseRef ? caseUuid(caseRef) : fc ? caseUuid(fc.id) : null;
  const key = `firm:${caseRef || fc?.id || loanId}:${kind}:${owningEventId ?? "none"}`;
  const outbox = new PgOutbox(q(ctx));
  // the owning event is this command's (in memory until the unit of work appends it): `source_event_id` (a non-deferrable FK, 0023) is stamped by a deferred write after the append; `owning_event_id` on the dispatch row is deferred to COMMIT
  const { message, duplicate } = await outbox.enqueue({ adapter: LAW_FIRM_ADAPTER, idempotencyKey: key, payload: { method: "deliver", args: [payload] }, payloadSummary: { kind, case_ref: payload["case_ref"], firm_id: firmId, owning_event_id: owningEventId }, loanId }, ctx.now);
  const deferWrite = rt.services["deferWrite"] as ((fn: (qx: Queryable) => Promise<void>) => void) | undefined;
  if (owningEventId && deferWrite && !duplicate) deferWrite(async (qx) => { await qx.query(`UPDATE integration_messages SET source_event_id = $2::uuid WHERE id = $1::uuid AND source_event_id IS NULL`, [message.id, owningEventId]); });
  const existing = await q(ctx).query<DispatchRow>(`SELECT ${SEL} FROM firm_dispatches WHERE integration_message_id = $1::uuid`, [message.id]);
  if (duplicate && existing[0]) return { dispatch_id: existing[0].id, integration_message_id: message.id, duplicate: true };
  const rows = await q(ctx).query<DispatchRow>(
    `INSERT INTO firm_dispatches (loan_id, case_id, firm_id, kind, owning_event_id, integration_message_id, document_id, created_at) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8::timestamptz) RETURNING ${SEL}`,
    [loanId, caseId, firmId, kind, owningEventId, message.id, s(i, "document_id") || null, ctx.now]);
  const d = rows[0]!;
  // the port sees the dispatch by its owning event's date: stored on the message so the drain (and the FAKE) reads it without this module
  const m = await dispatchMessage(q(ctx), d, payload);
  await q(ctx).query(`UPDATE integration_messages SET payload_summary = payload_summary || $2::jsonb WHERE id = $1::uuid`, [message.id, JSON.stringify({ payload: { method: "deliver", args: [m] } })]);
  ctx.events.append({ type: EV.firmDispatchSent, loanId, actor: ctx.actor, payload: { dispatch_id: d.id, case_id: caseId, case_ref: payload["case_ref"], firm_id: firmId, kind, integration_message_id: message.id, owning_event_id: owningEventId, idempotency_key: key } });
  return { dispatch_id: d.id, integration_message_id: message.id, firm_id: firmId, kind, duplicate: false };
}

/** The `law-firm` outbound adapter over the port (the seam's adapter contract): the message's payload is the `FirmDispatchMessage`. */
export function lawFirmAdapter(port: LawFirmPort | undefined): OutboundAdapter {
  return {
    name: LAW_FIRM_ADAPTER, fallbackKind: "law_firm_manual", fallbackRole: "attorney",
    async send(payload: unknown, m: OutboxMessage): Promise<unknown> {
      if (!port) throw new PortUnavailable("lawFirm");
      const p = payload as { method?: string; args?: unknown[] } | null;
      const msg = (Array.isArray(p?.args) ? p!.args[0] : payload) as FirmDispatchMessage;
      return port.deliver(msg, m.lastAttemptAt ?? m.createdAt);
    },
  };
}
/** The completion hook (35.1 rule 11, inside the dispatch transaction): the delivery stamp on the dispatch row. */
export const lawFirmCompletion: OutboxCompletion = async (io, message) => {
  await io.q.query(`UPDATE firm_dispatches SET sent_at = $2::timestamptz WHERE integration_message_id = $1::uuid AND sent_at IS NULL`, [message.id, io.now]);
};

export async function dispatchesOf(qx: Queryable, loanId: string): Promise<DispatchRow[]> { return qx.query<DispatchRow>(`SELECT ${SEL} FROM firm_dispatches WHERE loan_id = $1::uuid ORDER BY created_at, id`, [loanId]); }
const messagePayload = async (qx: Queryable, d: DispatchRow): Promise<FirmDispatchMessage | null> => {
  if (!d.integration_message_id) return null;
  const m = (await qx.query<{ payload_summary: Row }>(`SELECT payload_summary FROM integration_messages WHERE id = $1::uuid`, [d.integration_message_id]))[0];
  const inner = (m?.payload_summary["payload"] as { args?: unknown[] } | undefined)?.args?.[0];
  return (inner as FirmDispatchMessage | undefined) ?? null;
};
/** The FAKE's replies due on or before `asOf` for every delivered dispatch of the loan, minus the ones already ingested (the inbound `integration_messages` rows). */
export async function dueFirmReplies(qx: Queryable, port: LawFirmPort, loanId: string, asOf: string): Promise<{ dispatch: DispatchRow; message: FirmDispatchMessage; reply: FirmReply }[]> {
  const out: { dispatch: DispatchRow; message: FirmDispatchMessage; reply: FirmReply }[] = [];
  for (const d of await dispatchesOf(qx, loanId)) {
    if (!d.sent_at) continue;
    const m = await messagePayload(qx, d); if (!m) continue;
    for (const reply of port.repliesFor(m, asOf)) {
      const seen = await qx.query<{ id: string }>(`SELECT id::text AS id FROM integration_messages WHERE adapter = $1 AND direction = 'in' AND idempotency_key = $2`, [LAW_FIRM_ADAPTER, reply.reply_id]);
      if (!seen.length) out.push({ dispatch: d, message: m, reply });
    }
  }
  return out;
}

/**
 * `firm.inbound{firm_id, kind, payload, dispatch_id?, reply_id?}` — a firm's reply becomes the owning section's event with `source: firm`:
 * ack → 13.3 ACK ingest (`firm.referral.acknowledged` + `foreclosure.referral.acknowledged`), plus the firm's forecast as the
 * `first_legal` expectation (basis firm_forecast) and the dispatch's `ack_source: fake`; document request → 13.3 DOCUMENT_REQUEST;
 * milestone → 13.3 MILESTONE; sale → 13.3 SALE_SCHEDULED; invoice → 13.6 `invoice.review{op: received}`; dra_snapshot → 13.6 `dra.snapshot.import`.
 */
export async function firmInbound(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<Row> {
  need(i, "firm_id", "kind"); const loanId = s(i, "loan_id") || ctx.loanId; need({ loan_id: loanId }, "loan_id");
  const kind = s(i, "kind"); const p = ((i.payload as Row | undefined) ?? {});
  const replyId = s(i, "reply_id") || `firm:${s(i, "firm_id")}:${kind}:${s(i, "dispatch_id") || "manual"}:${String(p["occurred_on"] ?? p["acknowledged_on"] ?? p["sale_at"] ?? ctx.now.slice(0, 10))}`;
  const outbox = new PgOutbox(q(ctx));
  const { message, duplicate } = await outbox.enqueue({ adapter: LAW_FIRM_ADAPTER, direction: "in", idempotencyKey: replyId, payload: { kind, ...p }, payloadSummary: { kind, firm_id: s(i, "firm_id"), dispatch_id: s(i, "dispatch_id") || null, source: s(i, "source") || "fake" }, loanId }, ctx.now);
  if (duplicate) return { ingested: false, duplicate: true, reply_id: replyId, integration_message_id: message.id };
  await q(ctx).query(`UPDATE integration_messages SET status = 'acked', acked_at = $2::timestamptz WHERE id = $1::uuid`, [message.id, ctx.now]);
  const caseRef = s(i, "case_id") || String(p["case_ref"] ?? p["case_id"] ?? "") || (openForeclosure(await loanRows(q(ctx), "foreclosure_cases", loanId))?.id ?? "");
  const firmId = s(i, "firm_id");
  const base = { op: "firm_message", loan_id: loanId, case_id: caseRef, firm_id: firmId };
  let owning: string | null = null; let detail: Row = {};
  switch (kind) {
    case "ack": {
      const r = await delegate(rt, ctx, "13.2", "attorney.instruction.status", { ...base, kind: "ACK", referral_id: String(p["referral_id"] ?? `ref-${caseRef}-${String(p["referral_sent_on"] ?? "")}`), complete: p["complete"] !== false, missing: Array.isArray(p["missing"]) ? p["missing"] : [], acknowledged_on: String(p["acknowledged_on"] ?? ctx.now.slice(0, 10)) });
      owning = r.event_id;
      const forecast = typeof p["forecast_first_legal_on"] === "string" ? p["forecast_first_legal_on"] : null;
      if (forecast && caseRef) {
        const fc = rt.store.get("foreclosure_cases", caseRef) ?? null;
        const row = await writeExpectation({ q: q(ctx), events: ctx.events, now: ctx.now, actor: ENGINE_ACTOR, workItems: (await import("./ports.ts")).portsOf(rt.services["default_ops_ports"] as never).workItems, timers: ctx.timers },
          { loan_id: loanId, case_id: caseUuid(caseRef), case_kind: "foreclosure", milestone_code: "first_legal", expected_on: forecast as never, basis: "firm_forecast", basis_ref: String(p["firm_message_id"] ?? replyId), supersede: true });
        detail = { forecast_first_legal_on: forecast, expectation_id: row.id, method: methodOf(fc) };
      }
      const stamped = await q(ctx).query<{ id: string }>(`UPDATE firm_dispatches SET acknowledged_at = $3::timestamptz, ack_source = $4, ack_event_id = $5::uuid WHERE loan_id = $1::uuid AND kind = 'referral_package' AND firm_id = $2 AND acknowledged_at IS NULL RETURNING id::text AS id`, [loanId, firmId, ctx.now, s(i, "source") === "firm_message" ? "firm_message" : "fake", owning]);
      for (const d of stamped) ctx.events.append({ type: EV.firmDispatchAcknowledged, loanId, actor: ctx.actor, payload: { dispatch_id: d.id, case_id: caseRef ? caseUuid(caseRef) : null, firm_id: firmId, ack_source: s(i, "source") === "firm_message" ? "firm_message" : "fake", ack_event_id: owning } });
      detail = { ...detail, dispatches_acknowledged: stamped.map((d) => d.id) };
      break; }
    case "document_request": { const r = await delegate(rt, ctx, "13.2", "attorney.instruction.status", { ...base, kind: "DOCUMENT_REQUEST", request_id: String(p["request_id"] ?? replyId), items: Array.isArray(p["items"]) ? p["items"] : [], requested_on: String(p["requested_on"] ?? ctx.now.slice(0, 10)) }); owning = r.event_id; break; }
    case "milestone": { const r = await delegate(rt, ctx, "13.2", "attorney.instruction.status", { ...base, kind: "MILESTONE", code: String(p["code"] ?? "").toUpperCase(), occurred_on: String(p["occurred_on"] ?? ctx.now.slice(0, 10)), source: "firm", ...(p["evidence_document_id"] ? { evidence_document_id: String(p["evidence_document_id"]) } : {}) }); owning = r.event_id; break; }
    case "sale": { const r = await delegate(rt, ctx, "13.2", "attorney.instruction.status", { ...base, kind: "SALE_SCHEDULED", sale_at: String(p["sale_at"] ?? ""), method: String(p["method"] ?? "judicial"), ...(p["rescheduled_from"] ? { rescheduled_from: String(p["rescheduled_from"]) } : {}) }); owning = r.event_id; break; }
    case "invoice": { const r = await delegate(rt, ctx, "13.6", "invoice.review", { op: "received", loan_id: loanId, firm_id: firmId, ...p }); owning = r.event_id; break; }
    case "dra_snapshot": { const r = await delegate(rt, ctx, "13.6", "dra.snapshot.import", { loan_id: loanId, firm_id: firmId, ...p }); owning = r.event_id; break; }
    default: throw new RangeError("kind must be ack | document_request | milestone | sale | invoice | dra_snapshot (35.9 Inputs: inbound from the law-firm port)");
  }
  ctx.events.append({ type: EV.firmInboundReceived, loanId, actor: ctx.actor, payload: { firm_id: firmId, kind, owning_event_id: owning, reply_id: replyId, dispatch_id: s(i, "dispatch_id") || null, case_ref: caseRef || null, ...detail } });
  return { ingested: true, duplicate: false, reply_id: replyId, owning_event_id: owning, integration_message_id: message.id, ...detail };
}

/** rule 2 / rule 8: the daily unit's firm step — every due reply of the loan's delivered dispatches, ingested in order. */
export async function ingestDueReplies(i: ToolInput, ctx: CommandContext, rt: ToolRuntime, asOf: string): Promise<Row> {
  const port = rt.ports.lawFirm; if (!port) return { skipped: "no law-firm port" };
  const loanId = s(i, "loan_id") || ctx.loanId;
  const due = await dueFirmReplies(q(ctx), port, loanId, asOf);
  const ingested: string[] = [];
  for (const r of due) {
    const out = await firmInbound({ loan_id: loanId, firm_id: r.message.firm_id, kind: r.reply.kind, case_id: r.message.payload["case_ref"] ?? r.message.case_id, dispatch_id: r.dispatch.id, reply_id: r.reply.reply_id, source: "fake", payload: r.reply.payload }, ctx, rt);
    if (out["ingested"]) ingested.push(r.reply.reply_id);
  }
  return { due: due.length, ingested };
}
