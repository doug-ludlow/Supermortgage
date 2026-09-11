/**
 * 32.12 — Exits: the Record projection of a loan leaving servicing (spec/sections/32-borrower-experience/32-12-exits.md
 * §1.2 badge/Dates rows, §2 transfer-out rows, §3 the confirmed successor's communications choice). Pure read-model
 * helpers over the loan's events, the entity rows the owning tools stored (17.2's `transfer_notice_runs` with the
 * goodbyeTiming facts, 17.1's `transfer_batches` with the transferee block) and the batch-subject timers — nothing here
 * computes a regulatory date or a money figure: every date rendered was stored by the owning process or armed by the
 * Timer Engine. Kept apart from record.ts so the 32.12 flow file can import record.ts without a cycle.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import { decodeEntityData } from "../../../infra/db/entities.ts";

export interface ExitEv { readonly sequence: string; readonly type: string; readonly occurred_at: string; readonly payload: Record<string, unknown> }
export interface ExitTimer { readonly id: string; readonly code: string; readonly status: string; readonly due_at: string | null; readonly due_date: string | null; readonly armed_at: string }
/** The transfer-out facts the loan's goodbye / combined mailing points at (17.2 `transfer_notice_runs`, 17.1 `transfer_batches`). */
export interface TransferFacts {
  readonly batch_id: string; readonly run_id: string; readonly template: string; readonly mailed_at: string; readonly transfer_date: string | null; readonly respa_effective_date: string | null;
  readonly transferor_stops: string | null; readonly transferee_starts: string | null; readonly window_end: string | null; readonly ach_cancel_by: string | null;
  readonly new_servicer: string; readonly address: string; readonly tollfree: string; readonly protection_expired: boolean;
}
export interface ExitsContext {
  readonly fundsReceived: ExitEv | undefined;
  readonly paidInFull: ExitEv | undefined;
  /** paid in full and every 16.2 housekeeping task completed (§1.2 `housekeeping_complete → closed`). */
  readonly closed: boolean;
  readonly transfer: TransferFacts | null;
  readonly batchTimers: readonly ExitTimer[];
  /** 4.4 `case.sii.acknowledgment.returned{elected_notices=false}` on the loan: the successor declined the borrower's regular notices. */
  readonly successorDeclined: boolean;
  /** notice ids / template codes addressed to a given party (from `notice.sent{recipients|channels}`). */
  readonly addressed: ReadonlyMap<string, Set<string>>;
}

export const TRANSFER_OUT_NOTICES: ReadonlySet<string> = new Set(["NTC_REGX_1024_33B_GOODBYE_MS2", "NTC_REGX_1024_33B_COMBINED_MS2"]);
export const EXIT_TIMER_LABELS: readonly { code: string; label: string; calendar: string }[] = [
  { code: "STATE_LIEN_RELEASE_DEADLINE", label: "Lien release recorded by", calendar: "calendar days" },
  { code: "CA_CC2941_TRUSTEE_DELIVERY_30", label: "Release papers to the trustee by", calendar: "calendar days" },
  { code: "REGX_1024_33B3_COMBINED_15", label: "Transfer notice mailed by", calendar: "calendar days" },
  { code: "REGX_1024_33B3_GOODBYE_15", label: "Transfer notice mailed by", calendar: "calendar days" },
  { code: "REGX_1024_33C1_LATE_FEE_PROTECTION_60", label: "Payment protection ends", calendar: "calendar days" },
  { code: "SM_PAYOFF_SHORTAGE_UNCURED_30", label: "Payoff shortage due by", calendar: "calendar days" },
];
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (v: unknown): string => { if (v === undefined || v === null || v === "") return ""; try { return USD.format(Number(BigInt(String(v))) / 100); } catch { return ""; } };
const noon = (d: string): string => (d.length === 10 ? `${d}T12:00:00.000Z` : d);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Load the exits facts for one loan: the goodbye run row the loan's mailing names, the batch's transferee block, the batch-subject timers. */
export async function loadExitsContext(db: Queryable, loanId: string, events: readonly ExitEv[]): Promise<ExitsContext> {
  const cleared = events.filter((e) => e.type === "payoff.funds.cleared" || e.type === "payoff.funds.received").at(-1);
  // an uncured shortage applied per the note (16.2 rule 5) ends the payoff: the loan stays open and the funds card is history
  const appliedPerNote = cleared ? events.some((e) => e.type === "payoff.shortage.resolved" && e.payload["outcome"] === "applied_per_note" && Number(e.sequence) > Number(cleared.sequence)) : false;
  const fundsReceived = appliedPerNote ? undefined : cleared;
  const paidInFull = events.filter((e) => e.type === "loan.paid_in_full").at(-1);
  const created = events.filter((e) => e.type === "payoff.housekeeping.created" && (!paidInFull || Number(e.sequence) >= Number(paidInFull.sequence))).at(-1);
  const tasks = (created?.payload["tasks"] as unknown[] | undefined)?.map(String) ?? [];
  const completed = new Set(events.filter((e) => e.type === "payoff.housekeeping.completed" && (!created || Number(e.sequence) > Number(created.sequence))).map((e) => String(e.payload["task"])));
  const closed = !!paidInFull && tasks.length > 0 && tasks.every((t) => completed.has(t));
  const mailed = events.filter((e) => e.type === "notice.mailed" && TRANSFER_OUT_NOTICES.has(String(e.payload["template"])) && typeof e.payload["batch_id"] === "string").at(-1);
  let transfer: TransferFacts | null = null; let batchTimers: ExitTimer[] = [];
  if (mailed) {
    const batchId = String(mailed.payload["batch_id"]); const runId = String(mailed.payload["run_id"] ?? "");
    const rows = await db.query<{ kind: string; id: string; data: unknown }>(`SELECT kind, id, data FROM entity_current WHERE (kind = 'transfer_notice_runs' AND id = $1) OR (kind = 'transfer_batches' AND id = $2)`, [runId, batchId]);
    const run = rows.find((r) => r.kind === "transfer_notice_runs") ? decodeEntityData(rows.find((r) => r.kind === "transfer_notice_runs")!.data) : {};
    const batch = rows.find((r) => r.kind === "transfer_batches") ? decodeEntityData(rows.find((r) => r.kind === "transfer_batches")!.data) : {};
    const block = (batch["transferee_notice_block"] as Record<string, unknown> | undefined) ?? {};
    batchTimers = await db.query<ExitTimer & Record<string, unknown>>(`SELECT id, code, status::text AS status, due_at, due_date::text AS due_date, armed_at FROM timers WHERE subject_kind IN ('transfer_batch', 'batch') AND subject_id = $1 ORDER BY due_at NULLS LAST, armed_at`, [batchId]);
    const expired = events.some((e) => e.type === "transfer.protection_window.expired" && e.payload["batch_id"] === batchId);
    transfer = { batch_id: batchId, run_id: runId, template: String(mailed.payload["template"]), mailed_at: String(mailed.payload["mailed_at"] ?? mailed.occurred_at.slice(0, 10)),
      transfer_date: str(run["transfer_date"]) ?? str(batch["transfer_date"]), respa_effective_date: str(run["respa_effective_date"]) ?? str(batch["respa_effective_date"]), transferor_stops: str(run["transferor_stops"]), transferee_starts: str(run["transferee_starts"]), window_end: str(run["window_end"]), ach_cancel_by: str(run["ach_cancel_by"]),
      new_servicer: str(block["name"]) ?? "your new servicer", address: str(block["remittance_address"]) ?? str(block["address"]) ?? "", tollfree: str(block["tollfree"]) ?? "", protection_expired: expired };
  }
  const successorDeclined = events.some((e) => e.type === "case.sii.acknowledgment.returned" && e.payload["elected_notices"] === false);
  const addressed = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.type !== "notice.sent") continue;
    const parties = [...((e.payload["recipients"] as { party_id?: unknown }[] | undefined) ?? []), ...((e.payload["channels"] as { party_id?: unknown }[] | undefined) ?? [])].map((r) => String(r.party_id ?? "")).filter(Boolean);
    for (const p of parties) { const set = addressed.get(p) ?? new Set<string>(); if (typeof e.payload["template"] === "string") set.add(e.payload["template"]); if (typeof e.payload["notice_id"] === "string") set.add(e.payload["notice_id"]); addressed.set(p, set); }
  }
  void loanId;
  return { fundsReceived, paidInFull, closed, transfer, batchTimers, successorDeclined, addressed };
}

/** §1.2 / §2 badges, read off the event spine: Paying off → Paid off → Closed; Servicing moving → Transferred out. Null when none applies. */
export function exitsBadge(ctx: ExitsContext, asOf: string, timers: readonly ExitTimer[]): { badge: string; state_source: string; one_liner: string; one_liner_tokens?: Record<string, string> } | null {
  const today = asOf.slice(0, 10);
  const t = ctx.transfer;
  if (t && t.respa_effective_date && today >= t.respa_effective_date) {
    const inWindow = !t.protection_expired && (!t.window_end || today <= t.window_end);
    return { badge: "Transferred out", state_source: `transfer_notice_runs.status=complete; respa_effective_date=${t.respa_effective_date}`, one_liner: inWindow ? "transfer.after" : "transfer.after_window", one_liner_tokens: { new_servicer: t.new_servicer, date: t.respa_effective_date, through: t.window_end ?? "" } };
  }
  if (t) return { badge: "Servicing moving", state_source: `transfer_notice_runs.status=complete; template=${t.template}`, one_liner: "transfer.moving", one_liner_tokens: { new_servicer: t.new_servicer, date: t.respa_effective_date ?? t.transfer_date ?? "", through: t.transferor_stops ?? "" } };
  if (ctx.paidInFull) {
    if (ctx.closed) return { badge: "Closed", state_source: "payoff_settlements.status=closed (housekeeping complete)", one_liner: "closed" };
    const refund = timers.find((x) => x.code === "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD"); const release = timers.find((x) => x.code === "STATE_LIEN_RELEASE_DEADLINE");
    const p = ctx.paidInFull.payload;
    return { badge: "Paid off", state_source: "loans.status=paid_off", one_liner: "payoff.paid_in_full", one_liner_tokens: { money: money(p["escrow_balance_cents"] ?? p["escrow_refund_cents"]), date: refund?.due_date ?? "", n: release?.due_date ?? "", payoff_date: String(p["payoff_date"] ?? "") } };
  }
  if (ctx.fundsReceived) { const p = ctx.fundsReceived.payload; return { badge: "Paying off", state_source: `payoff_funds.status=${String(p["status"] ?? "cleared")}`, one_liner: "payoff.funds_received", one_liner_tokens: { date: String(p["received_on"] ?? p["credited_as_of"] ?? (typeof p["cleared_at"] === "string" ? (p["cleared_at"] as string).slice(0, 10) : ctx.fundsReceived.occurred_at.slice(0, 10))), money: money(p["amount_cents"]) } }; }
  return null;
}

/** §2 Dates rows: the stored goodbye-run facts (transferor stop, transferee start, protected window end) and the batch-subject clocks of the allow-list. */
export function exitsDates(ctx: ExitsContext, asOf: string, label: (code: string) => string, allowed: (code: string) => boolean, calendar: (code: string) => string): { timer_code: string; label: string; due_at: string; calendar: string; status: string }[] {
  const out: { timer_code: string; label: string; due_at: string; calendar: string; status: string }[] = [];
  const today = asOf.slice(0, 10); const t = ctx.transfer;
  if (t) {
    if (t.respa_effective_date && t.respa_effective_date >= today) out.push({ timer_code: "transfer.respa_effective_date", label: `Servicing moves to ${t.new_servicer}`, due_at: noon(t.respa_effective_date), calendar: "calendar", status: "scheduled" });
    if (t.transferor_stops && t.transferor_stops >= today) out.push({ timer_code: "transfer.transferor_stops", label: "Last payment to Supermortgage", due_at: noon(t.transferor_stops), calendar: "calendar", status: "scheduled" });
    if (t.transferee_starts && t.transferee_starts >= today) out.push({ timer_code: "transfer.transferee_starts", label: `First payment to ${t.new_servicer}`, due_at: noon(t.transferee_starts), calendar: "calendar", status: "scheduled" });
    if (t.window_end && t.window_end >= today && !t.protection_expired) out.push({ timer_code: "transfer.window_end", label: "Payment protection ends", due_at: noon(t.window_end), calendar: "calendar days", status: "scheduled" });
    const dedupe = new Map<string, ExitTimer>();
    for (const x of ctx.batchTimers) { if (!allowed(x.code) || !x.due_at) continue; const prev = dedupe.get(x.code); if (!prev || (x.status === "armed" && prev.status !== "armed") || x.armed_at > prev.armed_at) dedupe.set(x.code, x); }
    for (const x of dedupe.values()) if ((x.status === "armed" || x.status === "breached") && x.due_at! >= today) out.push({ timer_code: x.code, label: label(x.code), due_at: x.due_at!, calendar: calendar(x.code), status: x.status });
  }
  return out;
}

/** §2 Loan rows: autopay's end date on a transfer (the last draft is no later than the transferor stop date 17.2 stored); a termination; rate-watch `void` once the loan is paid off or transferred. */
export function exitsLoanFields(ctx: ExitsContext, events: readonly ExitEv[], autodraft: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const terminated = events.filter((e) => e.type === "autodraft.enrollment.terminated").at(-1);
  const ad: Record<string, unknown> = { ...(autodraft ?? { status: "none", next_draft_on: null, amount_cents: null, account_last4: null }) };
  if (terminated) { ad["status"] = "terminated"; ad["terminated_on"] = terminated.payload["terminated_on"] ?? terminated.occurred_at.slice(0, 10); ad["termination_reason"] = terminated.payload["reason"] ?? null; ad["next_draft_on"] = null; }
  if (ctx.transfer && ad["status"] !== "none" && ad["status"] !== "revoked") ad["ends_on"] = ctx.transfer.ach_cancel_by ?? ctx.transfer.transferor_stops ?? null;
  out["autodraft"] = ad;
  if (ctx.paidInFull || ctx.transfer) out["ratewatch_status"] = "void";
  return out;
}

/** §3: a confirmed successor who declined the borrower's notices sees only the notices addressed to them (their own §1024.36/.35 answers); statements never. */
export function exitsDocumentsFor(rows: Record<string, unknown>[], ctx: ExitsContext, viewer: { party_id: string; role: string }): Record<string, unknown>[] {
  if (viewer.role !== "confirmed_successor") return rows;
  const mine = ctx.addressed.get(viewer.party_id) ?? new Set<string>();
  return rows.filter((r) => { if (r["kind"] !== "notice") return true; const code = String(r["notice_code"] ?? ""); if (/STMT|STATEMENT/i.test(code) && !mine.has(code)) return false; return ctx.successorDeclined ? mine.has(code) : true; });
}
