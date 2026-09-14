/**
 * 33.1 — The partner book on the borrower surface (spec/sections/33-partner-book/33-1-*.md, rules 5 and 6): a loan loaded
 * from a partner's tape is `loans.status = monitored` — the partner keeps servicing it; the platform holds the account.
 *
 *   session opened (any door, any channel)   for every monitored loan among the party's subjects: `partner_book.account.activated`
 *                                            once per party × loan (loan-scoped, `origination: true` so the section-33 clocks see it;
 *                                            it satisfies SM_PARTNER_BOOK_INVITATION_REMINDER_14 in the same commit — the loan scope
 *                                            hydrates the loan's open timers)
 *   3-entry's session hook                   stands down (`isMonitoredOnly`): no organic lead, no organic application when every
 *                                            subject of the party is a monitored loan (33.1 rule 5)
 *   the command surface                      `MONITORED_REFUSED_COMMANDS` — payment, autopay, escrow and hardship commands refuse
 *                                            `LOAN_MONITORED` naming the servicer (33.1 rule 6; src/runtime/borrower/commands.ts)
 *
 * The flow reacts to no event and sends no card: nothing of sections 2–19 turns on for a monitored loan.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import type { Actor } from "../../../kernel/events/index.ts";
import { PgBorrowerPartyRepository, type Subject } from "../../../infra/db/borrower-parties.ts";
import type { BorrowerFlow, FlowDeps, SessionOpened } from "./index.ts";

const FLOW_ID = "33.1";
/** 33.1 rule 5: the session hook's event (the literal the timer lint reads — it satisfies SM_PARTNER_BOOK_INVITATION_REMINDER_14). */
export const ACCOUNT_ACTIVATED_EVENT = "partner_book.account.activated";
const BORROWER_API: Actor = { kind: "system", id: "borrower-api" };

/**
 * 33.1 rule 6: the payment, autopay, escrow and hardship commands a monitored loan never runs here (the partner services it) —
 * each refuses `LOAN_MONITORED` naming the servicer, before any write. `escrow.requestAnalysis` is named by the spec although it is
 * not a 32.2 command today: the refusal comes before the command-name gate so the answer is the monitored one, not COMMAND_UNKNOWN.
 */
export const MONITORED_REFUSED_COMMANDS: ReadonlySet<string> = new Set([
  "payment.makeOneTime", "payment.extraPrincipal",
  "autodraft.enroll", "autodraft.change", "autodraft.pause", "autodraft.revoke",
  "escrow.electShortage", "escrow.requestWaiver", "escrow.requestAnalysis",
  "pmi.requestCancellation",
  "lossmit.requestAssistance", "lossmit.respondToOffer", "lossmit.appeal",
]);

export interface MonitoredLoan { readonly loan_id: string; readonly servicer_loan_number: string | null; readonly partner_party_id: string | null; readonly partner_name: string | null; readonly partner_contact: Record<string, unknown> | null }

/** The monitored loans among the party's subjects (02 §6 resolution; `loans.status = monitored`), each with its servicer of record — the partner. */
export async function monitoredLoansOf(db: Queryable, partyId: string, subjects?: readonly Subject[]): Promise<MonitoredLoan[]> {
  const subs = subjects ?? (await new PgBorrowerPartyRepository(db).subjectsOf(partyId));
  const ids = [...new Set(subs.map((s) => s.loan_id).filter((x): x is string => !!x))];
  if (!ids.length) return [];
  return db.query<MonitoredLoan & Record<string, unknown>>(`SELECT l.id AS loan_id, l.servicer_loan_number, l.partner_party_id, p.legal_name AS partner_name, p.contact AS partner_contact FROM loans l LEFT JOIN parties p ON p.id = l.partner_party_id WHERE l.id = ANY($1::uuid[]) AND l.status = 'monitored' ORDER BY l.created_at, l.id`, [ids]);
}

/** The servicer of record of a monitored loan (the partner's `parties{servicer}` row), or null when the loan is not monitored. */
export async function monitoredServicerOf(db: Queryable, loanId: string): Promise<{ partner_party_id: string | null; partner_name: string | null } | null> {
  const row = (await db.query<{ partner_party_id: string | null; partner_name: string | null }>(`SELECT l.partner_party_id, p.legal_name AS partner_name FROM loans l LEFT JOIN parties p ON p.id = l.partner_party_id WHERE l.id = $1 AND l.status = 'monitored'`, [loanId]))[0];
  return row ?? null;
}

/**
 * 33.1 rule 5: every subject of the party is a monitored loan (at least one; no application, no serviced loan) — 3-entry's session
 * hook then stands down: no 20.3 lead, no organic application. A party that later opens a refinance application (33.3) is no longer
 * monitored-only and the entry hook runs for that application as usual.
 */
export async function isMonitoredOnly(db: Queryable, partyId: string, subjects?: readonly Subject[]): Promise<boolean> {
  const subs = subjects ?? (await new PgBorrowerPartyRepository(db).subjectsOf(partyId));
  if (!subs.length || subs.some((s) => s.application_id || !s.loan_id)) return false;
  const ids = [...new Set(subs.map((s) => s.loan_id as string))];
  const n = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loans WHERE id = ANY($1::uuid[]) AND status = 'monitored'`, [ids]))[0]?.n ?? "0";
  return Number(n) === ids.length;
}

/**
 * The first session on a monitored loan: `partner_book.account.activated{party_id, loan_id, session_id, activated_at, origination}`
 * once per party × loan (the log itself is the once-only check), appended in the loan's own unit of work so the reminder clock
 * armed by `partner_book.invitation.sent` is satisfied in the same commit. Returns the loan ids activated by this session.
 */
export async function activateMonitoredAccounts(deps: FlowDeps, s: SessionOpened): Promise<string[]> {
  const db = deps.runtime.db;
  const loans = await monitoredLoansOf(db, s.party_id);
  const activated: string[] = [];
  for (const l of loans) {
    const already = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE loan_id = $1 AND type = $2 AND payload->>'party_id' = $3`, [l.loan_id, ACCOUNT_ACTIVATED_EVENT, s.party_id]))[0]?.n ?? "0";
    if (Number(already) > 0) continue;
    await deps.runtime.uow.run({ loanId: l.loan_id }, (ctx) => {
      ctx.events.append({ type: ACCOUNT_ACTIVATED_EVENT, loanId: l.loan_id, aggregate: { kind: "loan", id: l.loan_id }, actor: BORROWER_API,
        payload: { party_id: s.party_id, loan_id: l.loan_id, session_id: s.session_id, activated_at: s.at, channel: s.channel, auth_method: s.auth_method, origination: true } });
    }, { clock: deps.runtime.clock });
    activated.push(l.loan_id);
    deps.logger?.info("borrower.flow.33-1.account.activated", { party_id: s.party_id, loan_id: l.loan_id, session_id: s.session_id, channel: s.channel });
  }
  return activated;
}

export const FLOW_15_PARTNER_BOOK: BorrowerFlow = {
  id: FLOW_ID,
  reacts: () => false,
  async onEvents() { /* the loan is monitored, not serviced: no card, no line, no reaction */ },
  async onSessionOpened(deps, s) { await activateMonitoredAccounts(deps, s); },
};
