/**
 * §35.9 rule 1 — "The timeline is a fold, not a status." One `case_timelines` row per consumed event per case, keyed by
 * `event_id` (unique, so folding twice writes nothing); `status_before` / `status_after` are the owning section's row as read
 * before and after the event — this process never writes a section's status (SECTION_STATUS_READ_ONLY). The fold runs in
 * every 35.9 command (inline, on the command's transaction), from the post-commit folder (folder.ts) for the sections'
 * commands, and from the daily unit for anything missed (`events_folded` counts the catch-up).
 *
 * Each newly folded row runs the reactions the spec ties to its event: the expectation map (rule 4), the unexpected-edge
 * check (State machine: an edge the map lacks → `case.status.unexpected` + an `ops_analyst` item, the section's row
 * untouched), the firm-acknowledgment stamp (rule 8), and the claim withdrawal on a reversed milestone (rule 9).
 */
import type { Queryable } from "../../../infra/db/client.ts";
import type { Actor, DomainEvent, EventStore } from "../../../kernel/events/index.ts";
import type { TimerEngine } from "../../../kernel/timers/engine.ts";
import { plainDate as D, type PlainDate } from "../../../kernel/calendar/date.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { CONSUMED_EVENT_TYPES, ENGINE_ACTOR, ET, EV, FORECLOSURE_EDGES, LOSSMIT_NOTICE_CODES, MILESTONE_CODE_OF, MOOT_STATUS, OWNING_KIND, kindOfEvent, type CaseKind, type TimelineSource } from "../default-35-9.ts";
import { cancelExpectations, expectationDate, onMilestoneRecorded, onReferralAcknowledged, onReferralSent, type CaseFacts, type Method } from "./expectations.ts";
import { caseUuid, currentRow, loanRows, openBankruptcy, openForeclosure, openLossmit, str, type CurrentRow, type Row } from "./store.ts";
import { decodeEntityData } from "../../../infra/db/entities.ts";
import type { WorkItemsPort } from "./ports.ts";

export interface FoldIo { readonly q: Queryable; readonly events: EventStore; readonly now: string; readonly actor?: Actor; readonly workItems: WorkItemsPort; readonly timers?: TimerEngine }
export type TimelineRow = {
  readonly id: string; readonly loan_id: string; readonly case_id: string | null; readonly case_kind: CaseKind; readonly event_id: string; readonly event_sequence: string; readonly event_type: string; readonly occurred_on: string;
  readonly source: TimelineSource; readonly status_before: string | null; readonly status_after: string | null; readonly milestone_code: string | null; readonly detail: Row;
};
export interface FoldResult { readonly folded: number; readonly through_sequence: number; readonly rows: TimelineRow[]; readonly unexpected: number }

const SEL = `id::text AS id, loan_id::text AS loan_id, case_id::text AS case_id, case_kind, event_id::text AS event_id, event_sequence::text AS event_sequence, event_type, occurred_on::text AS occurred_on, source, status_before, status_after, milestone_code, detail`;
type EvRow = { id: string; sequence: string; type: string; occurred_at: string; loan_id: string; actor_kind: string; actor_id: string; aggregate_kind: string | null; aggregate_id: string | null; payload: Row };

/** rule 1: who or what caused the event (Audit and evidence: section, firm, dra, docket, court, screen, cycle, sweep). */
export function sourceOf(e: { type: string; actor_kind: string; actor_id: string; payload: Row }): TimelineSource {
  const src = str(e.payload, "source").toLowerCase();
  if (e.type === "timer.breached" || e.actor_id === "sweep") return "sweep";
  if (src === "firm" || src === "firm_message" || e.type.startsWith("firm.")) return "firm";
  if (src === "dra" || e.type.startsWith("dra.")) return "dra";
  if (src === "pcl" || src === "ebn" || src === "docket" || src === "court_docket" || e.type === "bankruptcy.docket.event.received") return "docket";
  if (src === "court") return "court";
  if (e.actor_kind === "human") return "screen";
  if (str(e.payload, "run_kind") === "cycle" || str(e.payload, "job_id") !== "") return "cycle";
  return "section";
}

/** The case an event belongs to: the payload's `case_id` when it names one, else the loan's open row of the event's kind. */
export async function resolveCase(q: Queryable, loanId: string, kind: CaseKind, payload: Row): Promise<{ case_id: string | null; case_ref: string | null; row: CurrentRow | null }> {
  const named = str(payload, "case_id");
  if (kind === "early_intervention") return { case_id: null, case_ref: null, row: null };
  const owning = OWNING_KIND[kind];
  if (named) { const row = await currentRow(q, owning, named); return { case_id: caseUuid(named), case_ref: named, row }; }
  const rows = await loanRows(q, owning, loanId);
  const open = kind === "foreclosure" ? openForeclosure(rows) : kind === "bankruptcy" ? openBankruptcy(rows) : kind === "lossmit" ? openLossmit(rows) : rows[rows.length - 1] ?? null;
  if (open) return { case_id: caseUuid(open.id), case_ref: open.id, row: open };
  if (kind === "claim") { const claim = str(payload, "claim_id"); if (claim) { const row = (await currentRow(q, "mi_claims", claim)) ?? (await currentRow(q, "expense_claims", claim)); return { case_id: caseUuid(claim), case_ref: claim, row }; } }
  return { case_id: null, case_ref: null, row: null };
}
/** The owning row's status now (rule 1: read after the event, stored as `status_after`). */
export async function statusOf(q: Queryable, loanId: string, kind: CaseKind, row: CurrentRow | null): Promise<string | null> {
  if (kind === "early_intervention") { const w = await q.query<{ s: string }>(`SELECT live_status AS s FROM regx_ei_windows WHERE loan_id = $1::uuid ORDER BY due_date DESC LIMIT 1`, [loanId]); return w[0]?.s ?? null; }
  return row ? str(row.data, "status") || null : null;
}
/** The kind's initial status when the event created the row (the typed tables' defaults: foreclosure_cases 'prereferral', bankruptcy_cases 'open'). */
const INITIAL_STATUS: Readonly<Record<CaseKind, string | null>> = { early_intervention: null, lossmit: "received", foreclosure: "prereferral", bankruptcy: "open", reo: "open", claim: "opened" };
/** rule 1 `status_before` for a case's first timeline row: the owning row's version before the event (the store keeps every version), else the kind's initial status. */
async function statusBeforeOf(q: Queryable, kind: CaseKind, row: CurrentRow | null, occurredAt: string): Promise<string | null> {
  if (!row) return INITIAL_STATUS[kind];
  const prior = await q.query<{ data: unknown }>(`SELECT data FROM entity_records WHERE kind = $1 AND id = $2 AND updated_at < $3::timestamptz ORDER BY version DESC LIMIT 1`, [row.kind, row.id, occurredAt]);
  if (prior[0]) { const d = decodeEntityData(prior[0].data); return str(d, "status") || INITIAL_STATUS[kind]; }
  return INITIAL_STATUS[kind];
}
const kernelKind = async (q: Queryable, loanId: string): Promise<CaseKind> => {
  if (openForeclosure(await loanRows(q, "foreclosure_cases", loanId))) return "foreclosure";
  if (openBankruptcy(await loanRows(q, "bankruptcy_cases", loanId))) return "bankruptcy";
  if (openLossmit(await loanRows(q, "lossmit_applications", loanId))) return "lossmit";
  return "early_intervention";
};
const milestoneCodeOf = (type: string, payload: Row): string | null => {
  if (type === "foreclosure.milestone.recorded") { const c = str(payload, "code"); return MILESTONE_CODE_OF[c.toUpperCase()] ?? c.toLowerCase() ?? null; }
  if (type === "foreclosure.referral.acknowledged" || type === "firm.referral.acknowledged") return "referral_ack";
  if (type === "foreclosure.first_notice.filed") return "first_legal";
  if (type === "foreclosure.sale.scheduled") return "sale_scheduled";
  if (type === "foreclosure.sale.held" || type === "foreclosure.sale.completed") return "sale_held";
  if (type === "reogram.confirmed") return "reogram_confirmed";
  return null;
};
const scrub = (p: Row): Row => { const out: Row = {}; for (const [k, v] of Object.entries(p)) { if (/document_bytes|_enc$|^ssn|dob|address|name$/i.test(k)) continue; out[k] = typeof v === "bigint" ? v.toString() : v; } return out; };

export async function timelineOf(q: Queryable, loanId: string, caseId?: string | null): Promise<TimelineRow[]> {
  return q.query<TimelineRow>(`SELECT ${SEL} FROM case_timelines WHERE loan_id = $1::uuid ${caseId ? "AND case_id = $2::uuid" : ""} ORDER BY event_sequence`, caseId ? [loanId, caseUuid(caseId)] : [loanId]);
}
export const throughSequence = async (q: Queryable, loanId: string): Promise<number> => Number((await q.query<{ s: string | null }>(`SELECT max(event_sequence)::text AS s FROM case_timelines WHERE loan_id = $1::uuid`, [loanId]))[0]?.s ?? 0);

/** rule 1: fold every consumed event of the loan with `sequence` > the timeline's `through_sequence`; idempotent by `event_id`. */
export async function foldLoan(io: FoldIo, loanId: string, opts: { readonly limit?: number } = {}): Promise<FoldResult> {
  const through = await throughSequence(io.q, loanId);
  const evs = await io.q.query<EvRow>(`SELECT id::text AS id, sequence::text AS sequence, type, occurred_at::text AS occurred_at, loan_id::text AS loan_id, actor_kind::text AS actor_kind, actor_id, aggregate_kind, aggregate_id, payload
                                        FROM loan_events WHERE loan_id = $1::uuid AND sequence > $2 ORDER BY sequence LIMIT $3`, [loanId, through, opts.limit ?? 5000]);
  const rows: TimelineRow[] = []; let unexpected = 0; let last = through;
  for (const e of evs) {
    last = Number(e.sequence);
    if (!CONSUMED_EVENT_TYPES.has(e.type)) continue;
    const payload = (e.payload ?? {}) as Row;
    if (e.type === "notice.provided" && !LOSSMIT_NOTICE_CODES.has(str(payload, "code") || str(payload, "notice_code"))) continue;
    const kind = kindOfEvent(e.type) ?? await kernelKind(io.q, loanId);
    const c = await resolveCase(io.q, loanId, kind, payload);
    const after = await statusOf(io.q, loanId, kind, c.row);
    const prev = c.case_id
      ? (await io.q.query<{ s: string | null }>(`SELECT status_after AS s FROM case_timelines WHERE case_id = $1::uuid ORDER BY event_sequence DESC LIMIT 1`, [c.case_id]))[0]
      : (await io.q.query<{ s: string | null }>(`SELECT status_after AS s FROM case_timelines WHERE loan_id = $1::uuid AND case_kind = 'early_intervention' ORDER BY event_sequence DESC LIMIT 1`, [loanId]))[0];
    const before = prev ? prev.s : await statusBeforeOf(io.q, kind, c.row, e.occurred_at);
    const occurredOn: PlainDate = wallClock(Date.parse(e.occurred_at), ET).date;
    const source = sourceOf({ type: e.type, actor_kind: e.actor_kind, actor_id: e.actor_id, payload });
    const milestone = milestoneCodeOf(e.type, payload);
    const detail = { ...scrub(payload), ...(c.case_ref && c.case_ref !== c.case_id ? { case_ref: c.case_ref } : {}), actor: `${e.actor_kind}:${e.actor_id}` };
    const ins = await io.q.query<TimelineRow>(
      `INSERT INTO case_timelines (loan_id, case_id, case_kind, event_id, event_sequence, event_type, occurred_on, source, status_before, status_after, milestone_code, detail, created_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7::date, $8, $9, $10, $11, $12::jsonb, $13::timestamptz) ON CONFLICT (event_id) DO NOTHING RETURNING ${SEL}`,
      [loanId, c.case_id, kind, e.id, e.sequence, e.type, occurredOn, source, before, after, milestone, JSON.stringify(detail), io.now]);
    const row = ins[0]; if (!row) continue;
    rows.push(row);
    io.events.append({ type: EV.timelineAppended, loanId, actor: io.actor ?? ENGINE_ACTOR, payload: { loan_id: loanId, case_id: c.case_id, case_kind: kind, event_id: e.id, event_type: e.type, event_sequence: e.sequence, status_before: before, status_after: after, milestone_code: milestone, source } });
    if (kind === "foreclosure" && c.case_id && c.row) unexpected += await reactForeclosure(io, { loanId, caseId: c.case_id, caseRef: c.case_ref!, row: c.row, event: e, payload, before, after, occurredOn });
    if (kind === "claim" && (e.type === "foreclosure.sale.rescinded")) await withdrawCandidates(io, loanId, e.id, "milestone_reversed");
    if (e.type === "foreclosure.sale.rescinded") await withdrawCandidates(io, loanId, e.id, "milestone_reversed");
  }
  return { folded: rows.length, through_sequence: last, rows, unexpected };
}

const methodOf = (row: CurrentRow): Method => (str(row.data, "method") === "non_judicial" || str(row.data, "method") === "nonjudicial" ? "non_judicial" : "judicial");
export const caseFactsOf = (loanId: string, caseId: string, row: CurrentRow): CaseFacts => ({ loan_id: loanId, case_id: caseId, case_kind: "foreclosure", state: (str(row.data, "jurisdiction_state") || str(row.data, "state") || "FL").toUpperCase(), method: methodOf(row) });

/** The 13.x reactions of one folded foreclosure event (rule 4, rule 8's ack stamp, the state machine's unexpected edge). Returns 1 when the edge was unexpected. */
async function reactForeclosure(io: FoldIo, a: { loanId: string; caseId: string; caseRef: string; row: CurrentRow; event: EvRow; payload: Row; before: string | null; after: string | null; occurredOn: PlainDate }): Promise<number> {
  const c = caseFactsOf(a.loanId, a.caseId, a.row);
  const t = a.event.type; const p = a.payload;
  if (t === "foreclosure.referral.sent") await onReferralSent(io, c, { sent_on: expectationDate(p["sent_at"] ?? p["referral_sent_at"]) ?? a.occurredOn, ack_clock_ref: io.timers?.byCode("FNMA_E3205_FIRM_ACK_2BD").find((x) => x.status === "armed")?.id ?? null });
  if (t === "foreclosure.referral.acknowledged" || t === "firm.referral.acknowledged") {
    await onReferralAcknowledged(io, c, { event_id: a.event.id, forecast_first_legal_on: expectationDate(p["forecast_first_legal_on"] ?? p["first_legal_forecast_on"]), forecast_ref: str(p, "firm_message_id") || null });
    await stampAck(io, a.loanId, a.caseId, a.event.id, t === "firm.referral.acknowledged" ? "firm_message" : (str(p, "source") === "dra" ? "dra" : str(p, "ack_source") === "fake" ? "fake" : "firm_message"));
  }
  if (t === "foreclosure.milestone.recorded") await onMilestoneRecorded(io, c, { event_id: a.event.id, code: str(p, "code"), occurred_on: expectationDate(p["occurred_on"]) ?? a.occurredOn, forecast_next_on: expectationDate(p["forecast_next_on"]), source: str(p, "source") });
  if (t === "foreclosure.sale.scheduled") await onMilestoneRecorded(io, c, { event_id: a.event.id, code: "SALE_SCHEDULED", occurred_on: expectationDate(p["sale_at"] ?? p["occurred_on"]) ?? a.occurredOn, forecast_next_on: expectationDate(p["sale_at"]), source: str(p, "source") || "firm" });
  if (t === "foreclosure.sale.held" || t === "foreclosure.sale.completed") await onMilestoneRecorded(io, c, { event_id: a.event.id, code: "SALE_HELD", occurred_on: expectationDate(p["sale_on"] ?? p["held_on"] ?? p["occurred_on"]) ?? a.occurredOn, source: str(p, "source") || "firm" });
  if (a.after && MOOT_STATUS.test(a.after)) await cancelExpectations(io, { case_id: a.caseId, loan_id: a.loanId, cause: a.after });
  // the state machine's unexpected edge: the section's row is right by definition — the expectation map is what gets fixed
  if (a.before && a.after && a.before !== a.after && !(FORECLOSURE_EDGES.get(a.before)?.has(a.after) ?? false)) {
    const work_item_id = await io.workItems.open(io.q, { screen_code: "foreclosure_case", subject_kind: "loan", subject_id: a.loanId, loan_id: a.loanId, source_kind: "manual", source_id: `unexpected:${a.event.id}`, required_role: "ops_analyst", now: io.now, due_at: null });
    io.events.append({ type: EV.statusUnexpected, loanId: a.loanId, actor: io.actor ?? ENGINE_ACTOR, payload: { loan_id: a.loanId, case_id: a.caseId, case_ref: a.caseRef, from: a.before, to: a.after, event_id: a.event.id, work_item_id } });
    return 1;
  }
  return 0;
}

/** rule 8 / edge case: the firm's acknowledgment (message, DRA or the FAKE) stamps the referral dispatch once; a later duplicate changes nothing. */
export async function stampAck(io: FoldIo, loanId: string, caseId: string, ackEventId: string, ackSource: "firm_message" | "dra" | "fake"): Promise<string | null> {
  const rows = await io.q.query<{ id: string; firm_id: string }>(`UPDATE firm_dispatches SET acknowledged_at = $3::timestamptz, ack_source = $4, ack_event_id = $5::uuid WHERE loan_id = $1::uuid AND case_id = $2::uuid AND kind = 'referral_package' AND acknowledged_at IS NULL RETURNING id::text AS id, firm_id`, [loanId, caseId, io.now, ackSource, ackEventId]);
  const d = rows[0]; if (!d) return null;
  io.events.append({ type: EV.firmDispatchAcknowledged, loanId, actor: io.actor ?? ENGINE_ACTOR, payload: { dispatch_id: d.id, case_id: caseId, firm_id: d.firm_id, ack_source: ackSource, ack_event_id: ackEventId } });
  return d.id;
}

/** rule 9 / edge case: a claim milestone reversed after the candidate opened → `case.claim.withdrawn{cause}`; the 15.x claim row follows its own void path. */
export async function withdrawCandidates(io: FoldIo, loanId: string, eventId: string, cause: string): Promise<number> {
  const rows = await io.q.query<{ id: string; claim_kind: string }>(`UPDATE claim_candidates SET status = 'withdrawn', updated_at = $2::timestamptz WHERE loan_id = $1::uuid AND status IN ('opened', 'package_building', 'package_built') RETURNING id::text AS id, claim_kind`, [loanId, io.now]);
  for (const r of rows) io.events.append({ type: EV.claimWithdrawn, loanId, actor: io.actor ?? ENGINE_ACTOR, payload: { candidate_id: r.id, claim_kind: r.claim_kind, cause, event_id: eventId } });
  return rows.length;
}

export const eventDate = (e: DomainEvent): PlainDate => D(wallClock(Date.parse(e.occurredAt), ET).date);
