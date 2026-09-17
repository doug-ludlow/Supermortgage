/**
 * 36.4 rule 2 — the owners' rows, read as stored, into the pure projection's input (src/domain/servicing-partner-portal/
 * pipeline.ts pipelineOf): 20.1's `refi_opportunities` entity rows and their `refi.opportunity.*` events, 33.3's
 * `applications` with `prior_loan_id` and the latest `readiness_checks` row, 23.x's `du.findings.received`, 21.2's and 25.2's
 * `disclosure.*.delivered`, 23.3's / 26.x's clear to close, closing and funding events, 30.2's `loan.boarded` on the new
 * `loans` row (`origination_application_id`, `status = active`) and 21.6's dispositions by their events. Read by
 * ./eligibility.ts (the board's `pipeline_stage` and the banner's open application) and ./pipeline.ts (the feed); nothing
 * is written here (36.4 rule 8), nothing stored (no `pipeline_stage` column on `loans`).
 */
import { decodeEntityData } from "../../infra/db/entities.ts";
import { pipelineOf, type ApplicationMotion, type MotionInput, type OpportunityMotion, type PipelineProjection, type TerminalStage } from "../../domain/servicing-partner-portal/pipeline.ts";
import { CLOSED_APPLICATION_STATUSES, CLOSING_APPLICATION_EVENTS, openRefinanceApplicationSql } from "../partner-book-readiness.ts";
import type { Runtime } from "../app.ts";

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const OPPORTUNITY_EVENTS = ["refi.opportunity.offered", "refi.opportunity.engaged", "refi.opportunity.converted", "refi.opportunity.declined", "refi.opportunity.expired", "partner_book.refinance.opened"] as const;
const APPLICATION_EVENTS = ["application.received", "partner_book.refinance.opened", "du.findings.received", "disclosure.le.delivered", "disclosure.cd.delivered", "clear_to_close.issued", "closing.scheduled", "closing.consummated", "loan.funded", "loan.boarded", "application.withdrawn", "decision.issued", "application.closed_incomplete"] as const;

export interface LoanMotion { readonly input: MotionInput; readonly projection: PipelineProjection; readonly open_application_id: string | null }

/** The owners' rows for the loans, read as stored, per loan — the pure projection's input and its answer. */
export async function motionsOf(rt: Runtime, loanIds: readonly string[]): Promise<Map<string, LoanMotion>> {
  const out = new Map<string, LoanMotion>();
  if (!loanIds.length) return out;
  const db = rt.db;
  type Ev = { type: string; loan_id: string | null; application_id: string | null; occurred_at: string; payload: Row };
  const [oppRows, loanEvents, apps, open] = await Promise.all([
    db.query<{ id: string; loan_id: string; data: unknown }>(`SELECT id, loan_id, data FROM entity_current WHERE kind = 'refi_opportunities' AND loan_id = ANY($1::text[])`, [loanIds]),
    db.query<Ev>(`SELECT type, loan_id::text AS loan_id, application_id::text AS application_id, occurred_at::text AS occurred_at, payload FROM loan_events WHERE loan_id = ANY($1::uuid[]) AND type = ANY($2::text[]) ORDER BY sequence`, [loanIds, [...OPPORTUNITY_EVENTS]]),
    db.query<{ id: string; prior_loan_id: string; status: string; loan_id: string | null; created_at: string }>(`SELECT id::text AS id, prior_loan_id::text AS prior_loan_id, status::text AS status, loan_id::text AS loan_id, created_at::text AS created_at FROM applications WHERE prior_loan_id = ANY($1::uuid[]) ORDER BY created_at`, [loanIds]),
    db.query<{ id: string; prior_loan_id: string }>(`SELECT a.id::text AS id, a.prior_loan_id::text AS prior_loan_id FROM applications a WHERE ${openRefinanceApplicationSql({ loan: "ANY($1::uuid[])", statuses: "$2", events: "$3" })} ORDER BY a.created_at`, [loanIds, CLOSED_APPLICATION_STATUSES, CLOSING_APPLICATION_EVENTS]),
  ]);
  const appIds = apps.map((a) => a.id);
  const [appEvents, readiness, newLoans] = appIds.length ? await Promise.all([
    db.query<Ev>(`SELECT type, loan_id::text AS loan_id, application_id::text AS application_id, occurred_at::text AS occurred_at, payload FROM loan_events WHERE application_id = ANY($1::uuid[]) AND type = ANY($2::text[]) ORDER BY sequence`, [appIds, [...APPLICATION_EVENTS]]),
    db.query<{ application_id: string; missing: unknown }>(`SELECT DISTINCT ON (application_id) application_id::text AS application_id, missing FROM readiness_checks WHERE application_id = ANY($1::uuid[]) ORDER BY application_id, created_at DESC, id DESC`, [appIds]),
    db.query<{ loan_id: string; status: string; origination_application_id: string; boarded_at: string | null }>(`SELECT id::text AS loan_id, status::text AS status, origination_application_id::text AS origination_application_id, boarded_at::text AS boarded_at FROM loans WHERE origination_application_id = ANY($1::uuid[])`, [appIds]),
  ]) : [[], [], []];
  const iso = (s: string): string => new Date(s).toISOString();
  const firstAt = (evs: readonly Ev[], types: readonly string[], pick: (e: Ev) => boolean = () => true): string | null => { const e = evs.find((x) => types.includes(x.type) && pick(x)); return e ? iso(e.occurred_at) : null; };
  const missingOf = new Map(readiness.map((r) => [r.application_id, Array.isArray(r.missing) ? r.missing.map(String) : []]));
  const newLoanOf = new Map(newLoans.map((n) => [n.origination_application_id, n]));
  const openOf = new Map(open.map((o) => [o.prior_loan_id, o.id]));
  for (const loanId of loanIds) {
    const evs = loanEvents.filter((e) => e.loan_id === loanId);
    const opportunities: OpportunityMotion[] = oppRows.filter((o) => o.loan_id === loanId).map((o) => {
      const d = decodeEntityData(o.data) as Row; const mine = evs.filter((e) => e.payload["opportunity_id"] === o.id);
      return { opportunity_id: o.id, status: String(d["status"] ?? ""), offered_at: firstAt(mine, ["refi.opportunity.offered"]), engaged_at: firstAt(mine, ["refi.opportunity.engaged"]), declined_at: firstAt(mine, ["refi.opportunity.declined"]), expired_at: firstAt(mine, ["refi.opportunity.expired"]), application_id: str(d["application_id"]) };
    });
    const applications: ApplicationMotion[] = apps.filter((a) => a.prior_loan_id === loanId).map((a) => {
      const aev = appEvents.filter((e) => e.application_id === a.id);
      const opened = evs.find((e) => e.type === "partner_book.refinance.opened" && e.payload["application_id"] === a.id) ?? aev.find((e) => e.type === "partner_book.refinance.opened");
      const boarded = newLoanOf.get(a.id) ?? null; const boardedAt = firstAt(aev, ["loan.boarded"]) ?? boarded?.boarded_at ?? null;
      const denial = firstAt(aev, ["decision.issued"], (e) => e.payload["kind"] === "denial"); const notAccepted = firstAt(aev, ["decision.issued"], (e) => e.payload["kind"] === "approved_not_accepted");
      const withdrawn = firstAt(aev, ["application.withdrawn"]); const closedIncomplete = firstAt(aev, ["application.closed_incomplete"]);
      const terminal: { stage: TerminalStage; at: string }[] = [];
      if (withdrawn) terminal.push({ stage: "withdrawn", at: withdrawn }); if (denial) terminal.push({ stage: "denied", at: denial }); if (closedIncomplete) terminal.push({ stage: "closed_incomplete", at: closedIncomplete }); if (notAccepted) terminal.push({ stage: "approved_not_accepted", at: notAccepted });
      terminal.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
      return { application_id: a.id, opportunity_id: str(opened?.payload["opportunity_id"]), opened_at: opened ? iso(opened.occurred_at) : firstAt(aev, ["application.received"]) ?? iso(a.created_at), readiness_missing: missingOf.get(a.id) ?? null,
        du_at: firstAt(aev, ["du.findings.received"]), disclosures_at: firstAt(aev, ["disclosure.le.delivered", "disclosure.cd.delivered"]), closing_at: firstAt(aev, ["clear_to_close.issued", "closing.scheduled", "closing.consummated", "loan.funded"]),
        boarded: boarded && boardedAt ? { loan_id: boarded.loan_id, boarded_at: iso(boardedAt), status: boarded.status } : null, disposition: terminal[0] ?? null };
    });
    const input: MotionInput = { opportunities, applications };
    out.set(loanId, { input, projection: pipelineOf(input), open_application_id: openOf.get(loanId) ?? null });
  }
  return out;
}

