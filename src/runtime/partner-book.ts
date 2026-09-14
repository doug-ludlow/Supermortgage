/**
 * §33.1 — the partner book in the hosted runtime: the seam the route (`POST /v1/partner-book/imports`), the console and the
 * demo seed call.
 *
 *   importPartnerBook        the tape (.xlsx / .csv) and the supplement → parsed under the named profile (rule 1) → the plan of
 *                            writes against what the platform holds (src/app/tools/section33-1.ts planPartnerBook) → ONE unit of
 *                            work: `before` writes the baseline rows the events reference the way src/runtime/transfers.ts writes
 *                            them (parties, properties, loans{status=monitored}, borrowers, loan_borrowers, loan_terms{source=partner_tape});
 *                            the command appends the events (`partner_book.loan.loaded` per loan, `partner_book.account.provisioned`
 *                            per party, `partner_book.invitation.sent` per message through the Notice Registry, `partner_book.import.completed`
 *                            once, every payload `origination: true` so SM_PARTNER_BOOK_INVITATION_REMINDER_14 arms) and the decisions
 *                            (`book.import` once, `account.provision` and `account.invite` per party); `commit` writes the import row, the
 *                            facts rows, the invitation rows, the notice rows and the escalations. Idempotent on the file hashes
 *                            (`already_loaded` with the earlier import id — partner_book_imports_files_idx); a re-upload with a later
 *                            as-of date appends facts, closes the open loan_terms row and opens the new one (rule 2).
 *   partnerBookReport        an import's row and report as the console shows it.
 *   listPartnerBookImports   the imports, newest first.
 *   seedPartnerBookDemo      rule 7: the fixture book under the demo partner (idempotent; `main.ts seed-demo` and POST /v1/partner-book/seed-demo).
 *   sendPartnerBookReminders the breach action of SM_PARTNER_BOOK_INVITATION_REMINDER_14: one reminder on the same channel while no
 *                            session exists for the party, then nothing more (the reminder row is the idempotency; the clock stays closed).
 *
 * Never a destination in a payload, a decision, a report or a log line: sha256 hashes only (rule 3 / T4).
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../infra/db/client.ts";
import { toJson } from "../infra/db/client.ts";
import { PgNoticeRepository } from "../infra/db/notices.ts";
import { EntityStore } from "../app/tools.ts";
import { EscalationService } from "../app/escalations.ts";
import { NoticeService } from "../notices/service.ts";
import type { Actor } from "../kernel/events/index.ts";
import { plainDate, type PlainDate } from "../kernel/calendar/date.ts";
import { type ImportReport, type GapKind, emptyGaps, parseBook, profileById, readTabular, rowsWithExceptions, sha256Hex, contactDestinations, lastFour } from "../domain/partner-book/import.ts";
import { DEMO_AS_OF, DEMO_PARTNER, demoBook } from "../domain/partner-book/fixtures/partner-book-demo.ts";
import { INVITATION_TEMPLATE, PARTNER_BOOK_MODEL, PARTNER_BOOK_PROMPT, PARTNER_BOOK_RULE_SET, PORTFOLIO_AGENT, type BookPlan, type InvitationInput, type InvitationSubject, invitationEdelivery, inviteDecision, planPartnerBook, provisionAccount, sendInvitation } from "../app/tools/section33-1.ts";
import { partnerById } from "./borrower/partner.ts";
import { FAKE_PARTNER_NMLSR_ID } from "./entry-seed.ts";
import type { Runtime } from "./app.ts";

export type PartnerBookImportInput = {
  readonly partner: { readonly legal_name: string; readonly nmlsr_id: string; readonly servicer_number?: string; readonly mers_org_id?: string };
  readonly as_of_date: string;
  readonly profile: "m3-v1";
  readonly tape: { readonly filename: string; readonly content: Uint8Array };
  readonly supplement?: { readonly filename: string; readonly content: Uint8Array };
};
export type PartnerBookImportResult = {
  readonly import_id: string;
  readonly status: "loaded" | "rejected" | "already_loaded";
  readonly partner_party_id: string;
  readonly rows_total: number; readonly rows_loaded: number; readonly rows_exception: number;
  readonly loans_created: number; readonly loans_updated: number; readonly parties_created: number; readonly parties_linked: number; readonly invitations_sent: number;
  readonly report: ImportReport;
  readonly loans: { loan_id: string; servicer_loan_number: string; party_id: string | null; change: "created" | "updated" | "unchanged" }[];
};
export type PartnerBookImportListing = { import_id: string; partner_party_id: string; as_of_date: string; status: string; rows_total: number; rows_loaded: number; loans_created: number; invitations_sent: number; created_at: string };

const SYSTEM_PARTNER_BOOK: Actor = { kind: "system", id: "partner-book" };
const SEED_ACTOR: Actor = { kind: "system", id: "seed-demo" };
type ImportRow = { id: string; partner_party_id: string; as_of_date: string; profile: string; status: string; rows_total: number; rows_loaded: number; rows_exception: number; loans_created: number; loans_updated: number; parties_created: number; parties_linked: number; invitations_sent: number; report: ImportReport; created_at: string };
const IMPORT_COLUMNS = `id::text AS id, partner_party_id::text AS partner_party_id, as_of_date::text AS as_of_date, profile, status, rows_total, rows_loaded, rows_exception, loans_created, loans_updated, parties_created, parties_linked, invitations_sent, report, created_at::text AS created_at`;

const resultOf = (r: ImportRow, status: PartnerBookImportResult["status"]): PartnerBookImportResult => ({ import_id: r.id, status, partner_party_id: r.partner_party_id, rows_total: r.rows_total, rows_loaded: r.rows_loaded, rows_exception: r.rows_exception, loans_created: r.loans_created, loans_updated: r.loans_updated, parties_created: r.parties_created, parties_linked: r.parties_linked, invitations_sent: r.invitations_sent, report: r.report, loans: r.report.loans ?? [] });

/**
 * Operational prerequisites: the partner's `parties{servicer}` row (found by legal name, else created with the servicer number and
 * MERS org id), the global `partners/<id>` entity carrying the NMLSR id, and a `partner_programs` row through 20.1
 * `loadUniverse{op=register_program}` when the partner has none (product owner `partner`; 20.1 rules 6–8).
 *
 * Planned read-only (`planPartner`) and written only once the file has passed the profile gate (state machine: `rejected` —
 * "nothing is written"): the party row in the import's `before` hook and the entity in its `commit` hook — one transaction with
 * the loans, so a failed load rolls them back too — and the program through 20.1's own command once that transaction has
 * committed (idempotent: an import that fails after its commit leaves a partner the next import completes). `ensurePartner`
 * does all three at once for a caller that only needs the partner.
 */
export type PartnerPlan = {
  readonly id: string; readonly legal_name: string;
  /** The parties{servicer} row exists; otherwise `id` is the uuid the import's `before` hook inserts it under. */
  readonly exists: boolean;
  /** The store holding the new `partners/<id>` version (null when the entity exists). */
  readonly entity: EntityStore | null; readonly entity_mark: number;
  /** The program to register through 20.1 (null when the partner already has one). */
  readonly program_id: string | null;
};

export async function partnerPartyByName(db: Queryable, legalName: string): Promise<{ id: string; legal_name: string } | null> {
  return (await db.query<{ id: string; legal_name: string }>(`SELECT id, legal_name FROM parties WHERE party_type = 'servicer' AND lower(legal_name) = lower($1) ORDER BY created_at LIMIT 1`, [legalName]))[0] ?? null;
}

/** Reads only: what the partner needs written (the party, the entity, the program), nothing written. */
export async function planPartner(rt: Runtime, partner: PartnerBookImportInput["partner"], actor: Actor): Promise<PartnerPlan> {
  const name = partner.legal_name.trim(); if (!name) throw new RangeError("partner.legal_name is required");
  const existing = await partnerPartyByName(rt.db, name);
  const id = existing?.id ?? randomUUID(); const legal = existing?.legal_name ?? name;
  const store = new EntityStore(); store.seed(await rt.entities.load({}));
  const mark = store.versionCount();
  if (!store.get("partners", id)) store.put("partners", id, { partner_id: id, legal_name: legal, nmlsr_id: partner.nmlsr_id, ...(partner.servicer_number ? { servicer_number: partner.servicer_number } : {}), ...(partner.mers_org_id ? { mers_org_id: partner.mers_org_id } : {}), source: "partner_book" }, actor, rt.clock.now());
  const hasProgram = store.list("partner_programs").some((r) => r.data["partner_id"] === id);
  return { id, legal_name: legal, exists: !!existing, entity: store.versionsSince(mark).length ? store : null, entity_mark: mark, program_id: hasProgram ? null : `prog-refi-${id.slice(0, 8)}` };
}
/** The import's `before` hook: the parties{servicer} row the loans reference. */
async function writePartnerParty(q: Queryable, plan: PartnerPlan, partner: PartnerBookImportInput["partner"]): Promise<void> {
  if (plan.exists) return;
  await q.query(`INSERT INTO parties (id, party_type, legal_name, servicer_number, mers_org_id, contact) VALUES ($1, 'servicer', $2, $3, $4, $5::jsonb)`, [plan.id, plan.legal_name, partner.servicer_number ?? null, partner.mers_org_id ?? null, toJson({ nmlsr_id: partner.nmlsr_id })]);
}
/** The import's `commit` hook: the partners/<id> entity version, in the same transaction. */
async function writePartnerEntity(rt: Runtime, q: Queryable, plan: PartnerPlan): Promise<void> {
  if (plan.entity) await rt.entities.save(plan.entity.versionsSince(plan.entity_mark), {}, q);
}
/** After the import's commit: the partner_programs row through 20.1's own command (its own transaction). */
async function registerPartnerProgram(rt: Runtime, plan: PartnerPlan, actor: Actor): Promise<void> {
  if (!plan.program_id) return;
  await rt.execute({ process: "20.1", name: "loadUniverse", loanId: "", actor: SYSTEM_PARTNER_BOOK, input: { op: "register_program", program: { program_id: plan.program_id, partner_id: plan.id, effective_from: rt.clock.now().slice(0, 10), approved_by: `${actor.kind}:${actor.id}` } } });
}

export async function ensurePartner(rt: Runtime, partner: PartnerBookImportInput["partner"], actor: Actor): Promise<{ id: string; legal_name: string; written: string[] }> {
  const plan = await planPartner(rt, partner, actor);
  const written: string[] = [];
  if (!plan.exists || plan.entity) await rt.uow.run({}, async () => undefined, { clock: rt.clock, before: async (q) => { await writePartnerParty(q, plan, partner); }, commit: async (q) => { await writePartnerEntity(rt, q, plan); } });
  if (!plan.exists) written.push(`parties/${plan.id}`);
  if (plan.entity) written.push(`partners/${plan.id}`);
  await registerPartnerProgram(rt, plan, actor);
  if (plan.program_id) written.push(`partner_programs/${plan.program_id}`);
  return { id: plan.id, legal_name: plan.legal_name, written };
}

export async function importPartnerBook(rt: Runtime, input: PartnerBookImportInput, actor: Actor): Promise<PartnerBookImportResult> {
  const profile = profileById(input.profile);
  const asOf: PlainDate = plainDate(input.as_of_date);
  const partnerName = input.partner.legal_name.trim(); if (!partnerName) throw new RangeError("partner.legal_name is required");
  const tapeHash = sha256Hex(input.tape.content); const supplementHash = input.supplement ? sha256Hex(input.supplement.content) : null;
  // rule 1 / state machine: the files are parsed and header-gated before anything is looked up or written (parseBook needs no database),
  // so a file that is not the profile — or a mistyped partner name — leaves no servicer party, entity or program behind
  const parsed = parseBook(profile, readTabular(input.tape.filename, input.tape.content), input.supplement ? readTabular(input.supplement.filename, input.supplement.content) : null);
  const importId = randomUUID();
  const now = rt.clock.now();
  const actorId = `${actor.kind}:${actor.id}`;
  const existing = await partnerPartyByName(rt.db, partnerName);   // read-only

  if (parsed.rejected) {
    // state machine: `rejected` — the header row does not carry the profile's required columns; nothing but the import's own record (and the ops_analyst's work item) is written,
    // and for a partner not yet on the platform nothing at all: the answer carries the expected and missing columns
    const report: ImportReport = { profile: profile.id, exceptions: [], gaps: emptyGaps(), gaps_by_loan: {}, rejected: parsed.rejected, supplement: { rows: parsed.supplement_rows, matched: 0, orphans: 0 }, loans: [], invitations: [] };
    if (!existing) {
      rt.logger?.warn("partner book import rejected", { import_id: null, partner_party_id: null, partner_legal_name: partnerName, missing_headers: parsed.rejected.missing_headers, written: "nothing (the partner is not on the platform)" });
      return { import_id: "", status: "rejected", partner_party_id: "", rows_total: parsed.rows_total, rows_loaded: 0, rows_exception: 0, loans_created: 0, loans_updated: 0, parties_created: 0, parties_linked: 0, invitations_sent: 0, report, loans: [] };
    }
    const partner = existing;
    let escalations: EscalationService | undefined;
    await rt.uow.run({}, async (ctx) => {
      escalations = new EscalationService(ctx.events, ctx.clock);
      escalations.open({ kind: "human_portal_task", ownerRole: "ops_analyst", severity: "3", payload: { import_id: importId, partner_party_id: partner.id, reason: "rejected: the file is not the profile", profile: profile.id, missing_headers: parsed.rejected!.missing_headers, expected_headers: [...profile.required] } }, PORTFOLIO_AGENT);
      ctx.decide({ agent: "portfolio", action: "book.import", ruleSetVersion: PARTNER_BOOK_RULE_SET, modelVersion: PARTNER_BOOK_MODEL, promptVersion: PARTNER_BOOK_PROMPT, confidence: 1, subject: { kind: "partner_book_import", id: importId },
        rationale: `rejected: profile ${profile.id} requires headers the file lacks (${parsed.rejected!.missing_headers.join(", ")}); rows_total ${parsed.rows_total}; nothing written` });
      ctx.events.append({ type: "partner_book.import.completed", aggregate: { kind: "partner_book_import", id: importId }, actor: PORTFOLIO_AGENT, payload: { import_id: importId, partner_id: partner.id, as_of_date: asOf, status: "rejected", rows_total: parsed.rows_total, rows_loaded: 0, rows_exception: 0, loans_created: 0, loans_updated: 0, parties_created: 0, parties_linked: 0, invitations_sent: 0, gaps: report.gaps, missing_headers: parsed.rejected!.missing_headers, origination: true } });
    }, { clock: rt.clock, commit: async (q) => {
      await q.query(`INSERT INTO partner_book_imports (id, partner_party_id, as_of_date, profile, status, tape_sha256, supplement_sha256, rows_total, rows_loaded, rows_exception, report, actor_id) VALUES ($1, $2, $3, $4, 'rejected', $5, $6, $7, 0, 0, $8::jsonb, $9)`, [importId, partner.id, asOf, profile.id, tapeHash, supplementHash, parsed.rows_total, toJson(report), actorId]);
      for (const e of escalations?.list() ?? []) await rt.escalationRepo.save(e, q);
    } });
    rt.logger?.warn("partner book import rejected", { import_id: importId, partner_party_id: partner.id, missing_headers: parsed.rejected.missing_headers });
    return { import_id: importId, status: "rejected", partner_party_id: partner.id, rows_total: parsed.rows_total, rows_loaded: 0, rows_exception: 0, loans_created: 0, loans_updated: 0, parties_created: 0, parties_linked: 0, invitations_sent: 0, report, loans: [] };
  }

  // idempotent on the file hashes: the same files land once (data model) — the earlier import id, nothing written (a partner not yet on the platform has no prior import)
  if (existing) {
    const prior = (await rt.db.query<ImportRow>(`SELECT ${IMPORT_COLUMNS} FROM partner_book_imports WHERE partner_party_id = $1 AND tape_sha256 = $2 AND coalesce(supplement_sha256, '') = coalesce($3, '') ORDER BY created_at LIMIT 1`, [existing.id, tapeHash, supplementHash]))[0];
    if (prior) return resultOf(prior, prior.status === "rejected" ? "rejected" : "already_loaded");
  }
  // the partner's rows are planned here and written with the loans (before/commit hooks below), the program once the transaction has committed
  const partner: PartnerPlan = await planPartner(rt, input.partner, actor);
  const plan: BookPlan = await planPartnerBook(rt.db, parsed, partner.exists ? partner.id : null, asOf);
  // the ids every row and event carries are chosen here: the unit of work appends the events before the transaction opens, then `before` inserts the rows they reference
  const partyIds = new Map<string, string>();   // "plan:<row>" → the party id this import creates
  for (const l of plan.loans) if (l.party.party_id.startsWith("plan:") && !partyIds.has(l.party.party_id)) partyIds.set(l.party.party_id, randomUUID());
  const realParty = (id: string): string => partyIds.get(id) ?? id;
  const created = plan.loans.filter((l) => l.change === "created").length, updated = plan.loans.filter((l) => l.change === "updated").length;

  const report: ImportReport = { profile: profile.id, exceptions: plan.exceptions, gaps: plan.gaps, gaps_by_loan: plan.gaps_by_loan, rejected: null,
    supplement: { rows: parsed.supplement_rows, matched: plan.loans.filter((l) => l.row.supplement !== null).length, orphans: plan.exceptions.filter((e) => e.code === "supplement_orphan").length },
    loans: plan.loans.map((l) => ({ loan_id: l.loan_id, servicer_loan_number: l.row.servicer_loan_number, party_id: realParty(l.party.party_id), change: l.change })), invitations: [] };
  const invitationRows: { id: string; party_id: string; loan_id: string; channel: "email" | "sms"; destination_hash: string; notice_id: string; message_id: string; sent_at: string; bounced: boolean }[] = [];
  const invited = new Set<string>();   // "<party>:<channel>" — rule 4: once per provisioned party; the idempotency key partner_book:<import>:<party>:<channel> holds one message
  const noticeIds: string[] = [];
  let escalations: EscalationService | undefined; let notices: NoticeService | undefined;

  const r = await rt.uow.run({}, async (ctx) => {
    escalations = new EscalationService(ctx.events, ctx.clock);
    const overrides = new Map<string, InvitationSubject>();
    const edelivery = rt.ports.edelivery && rt.ports.printMail ? invitationEdelivery(rt.ports.edelivery, overrides) : null;
    notices = edelivery ? new NoticeService({ registry: rt.noticeRegistry, events: ctx.events, clock: ctx.clock, printMail: rt.ports.printMail!, edelivery, notices: rt.noticeMemory }) : undefined;
    for (const l of plan.loans) {
      const partyId = realParty(l.party.party_id);
      // rule 2: the loan is monitored and the record of it is the partner's — created | updated | unchanged
      ctx.events.append({ type: "partner_book.loan.loaded", loanId: l.loan_id, aggregate: { kind: "loan", id: l.loan_id }, actor: PORTFOLIO_AGENT,
        payload: { loan_id: l.loan_id, servicer_loan_number: l.row.servicer_loan_number, as_of_date: asOf, change: l.change, import_id: importId, partner_id: partner.id, ...(l.derivation.status_transition ? { status: l.derivation.status_transition, tape_status: l.row.facts["servicing_status"] } : {}), ...(l.row.exceptions.length ? { exceptions: l.row.exceptions.map((e) => e.code) } : {}), origination: true } });
      // rule 3: one homeowner, one party, real from the first load (an existing loan's party is left as it is)
      if (!l.party.existing_party_id && l.party.resolution) {
        const res = l.party.resolution;
        provisionAccount(ctx.events, ctx, PORTFOLIO_AGENT, { party_id: partyId, loan_id: l.loan_id, borrower_id: l.borrower_id, servicer_loan_number: l.row.servicer_loan_number, channels: l.channels, linked_existing_party: res.kind === "link", gaps: l.gaps,
          email: res.kind === "link" ? l.row.supplement?.email ?? null : res.email, phone: res.kind === "link" ? l.row.supplement?.phone ?? null : res.phone });
        if (res.kind === "create" && res.conflict) escalations.open({ kind: "human_portal_task", ownerRole: "ops_analyst", loanId: l.loan_id, severity: "3", payload: { import_id: importId, servicer_loan_number: l.row.servicer_loan_number, row: l.row.row, reason: "contact_conflict: the supplement's e-mail is on a party with another name; the loan's own party carries no e-mail (33.1 rule 3)" } }, PORTFOLIO_AGENT);
      }
      // rule 4: the invitation, once per provisioned party per channel, through the Notice Registry — a homeowner with two loans on the
      // tape is provisioned per loan (above) and invited once, on the first loan (the FAKE port holds one message per party: T6)
      if (l.invite && notices && edelivery) {
        const display = typeof l.row.facts["borrower_name"] === "string" && l.row.facts["borrower_name"].trim() ? l.row.facts["borrower_name"].trim() : "Borrower";
        const contact = l.party.existing_party_id ? l.party.contact_update! : { email: l.party.resolution!.kind === "link" ? l.row.supplement?.email ?? null : l.party.resolution!.email, phone: l.party.resolution!.kind === "link" ? l.row.supplement?.phone ?? null : l.party.resolution!.phone };
        for (const channel of l.channels) {
          const destination = channel === "email" ? contact.email : contact.phone; if (!destination) continue;
          const key = `${partyId}:${channel}`; if (invited.has(key)) continue; invited.add(key);
          const inv: InvitationInput = { import_id: importId, party_id: partyId, loan_id: l.loan_id, kind: "invitation", channel, destination, display_name: display, partner_legal_name: partner.legal_name, servicer_loan_number: l.row.servicer_loan_number, consent_id: channel === "sms" ? l.sms_consent_id : null };
          const sent = await sendInvitation({ notices, edelivery, events: ctx.events, clock: ctx.clock, actor: PORTFOLIO_AGENT, overrides }, inv);
          inviteDecision(ctx, inv, sent);
          noticeIds.push(sent.notice_id);
          report.invitations.push({ party_id: partyId, loan_id: l.loan_id, channel, destination_hash: sent.destination_hash, notice_id: sent.notice_id, bounced: sent.bounced, held_reason: sent.held_reason });
          if (sent.held_reason) {
            // the registry's checklist held the rendered notice, so nothing went out: the report says so (`held_reason`), the gap counts it
            // (`invitation_held`), the ops_analyst gets the work item (AI agent design: escalations) and the log warns — hashes only, never a destination
            report.gaps.invitation_held++; (report.gaps_by_loan[l.row.servicer_loan_number] ??= []).push("invitation_held");
            escalations.open({ kind: "human_portal_task", ownerRole: "ops_analyst", loanId: l.loan_id, severity: "3", payload: { import_id: importId, party_id: partyId, servicer_loan_number: l.row.servicer_loan_number, channel, notice_id: sent.notice_id, reason: `invitation_held: the rendered NTC_SM_PARTNER_BOOK_INVITATION was held by its checklist (${sent.held_reason}); the homeowner has not been invited` } }, PORTFOLIO_AGENT);
            rt.logger?.warn("partner book invitation held", { import_id: importId, loan_id: l.loan_id, party_id: partyId, channel, notice_id: sent.notice_id, destination_hash: sent.destination_hash, reason: sent.held_reason });
            continue;
          }
          invitationRows.push({ id: randomUUID(), party_id: partyId, loan_id: l.loan_id, channel, destination_hash: sent.destination_hash, notice_id: sent.notice_id, message_id: sent.message_id, sent_at: sent.sent_at, bounced: sent.bounced });
          if (sent.bounced) { report.gaps.contact_bounced++; (report.gaps_by_loan[l.row.servicer_loan_number] ??= []).push("contact_bounced" as GapKind); }
        }
      }
    }
    const invitationsSent = invitationRows.length;
    ctx.decide({ agent: "portfolio", action: "book.import", ruleSetVersion: PARTNER_BOOK_RULE_SET, modelVersion: PARTNER_BOOK_MODEL, promptVersion: PARTNER_BOOK_PROMPT, confidence: 1, subject: { kind: "partner_book_import", id: importId },
      rationale: `profile ${profile.id} as of ${asOf}: rows_total ${parsed.rows_total}, rows_loaded ${plan.loans.length}, rows_exception ${rowsWithExceptions(plan.exceptions)}; loans created ${created}, updated ${updated}, unchanged ${plan.loans.length - created - updated}; parties created ${plan.parties_created}, linked ${plan.parties_linked}; invitations ${invitationsSent}; gaps ${toJson(plan.gaps)}` });
    ctx.events.append({ type: "partner_book.import.completed", aggregate: { kind: "partner_book_import", id: importId }, actor: PORTFOLIO_AGENT,
      payload: { import_id: importId, partner_id: partner.id, as_of_date: asOf, status: "loaded", rows_total: parsed.rows_total, rows_loaded: plan.loans.length, rows_exception: rowsWithExceptions(plan.exceptions), loans_created: created, loans_updated: updated, parties_created: plan.parties_created, parties_linked: plan.parties_linked, invitations_sent: invitationsSent, gaps: plan.gaps, origination: true } });
    return { invitationsSent };
  }, { clock: rt.clock,
    before: async (q) => { await writePartnerParty(q, partner, input.partner); await writeBaselineRows(q, plan, partner.id, realParty, asOf); },
    commit: async (q) => {
      await writePartnerEntity(rt, q, partner);
      await q.query(`INSERT INTO partner_book_imports (id, partner_party_id, as_of_date, profile, status, tape_sha256, supplement_sha256, rows_total, rows_loaded, rows_exception, loans_created, loans_updated, parties_created, parties_linked, invitations_sent, report, actor_id, created_at) VALUES ($1, $2, $3, $4, 'loaded', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17)`,
        [importId, partner.id, asOf, profile.id, tapeHash, supplementHash, parsed.rows_total, plan.loans.length, rowsWithExceptions(plan.exceptions), created, updated, plan.parties_created, plan.parties_linked, invitationRows.length, toJson(report), actorId, now]);
      for (const l of plan.loans) await q.query(`INSERT INTO partner_book_facts (id, import_id, loan_id, partner_party_id, as_of_date, facts, raw, created_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`, [randomUUID(), importId, l.loan_id, partner.id, asOf, toJson(l.row.facts), toJson(l.row.raw), now]);
      for (const inv of invitationRows) await q.query(`INSERT INTO partner_book_invitations (id, import_id, party_id, loan_id, channel, destination_hash, notice_id, message_id, sent_at, kind, bounced_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'invitation', $10)`, [inv.id, importId, inv.party_id, inv.loan_id, inv.channel, inv.destination_hash, inv.notice_id, inv.message_id, inv.sent_at, inv.bounced ? inv.sent_at : null]);
      if (notices) await persistNotices(rt, notices, noticeIds, asOf, q);
      for (const e of escalations?.list() ?? []) await rt.escalationRepo.save(e, q);
    } });

  await registerPartnerProgram(rt, partner, actor);   // 20.1 loadUniverse{op=register_program} for a partner without a program, once the book is committed

  rt.logger?.info("partner book import loaded", { import_id: importId, partner_party_id: partner.id, as_of_date: asOf, rows_total: parsed.rows_total, rows_loaded: plan.loans.length, rows_exception: rowsWithExceptions(plan.exceptions), loans_created: created, loans_updated: updated, parties_created: plan.parties_created, parties_linked: plan.parties_linked, invitations_sent: r.result.invitationsSent, events: r.events.length, timers: r.timers.length });
  return { import_id: importId, status: "loaded", partner_party_id: partner.id, rows_total: parsed.rows_total, rows_loaded: plan.loans.length, rows_exception: rowsWithExceptions(plan.exceptions), loans_created: created, loans_updated: updated, parties_created: plan.parties_created, parties_linked: plan.parties_linked, invitations_sent: r.result.invitationsSent, report, loans: report.loans };
}

/** The baseline rows, written the way src/runtime/transfers.ts writes them (the brief's "Rules that bind every write"), before the events that reference them. */
async function writeBaselineRows(q: Queryable, plan: BookPlan, partnerPartyId: string, realParty: (id: string) => string, asOf: PlainDate): Promise<void> {
  const partiesWritten = new Set<string>();
  for (const l of plan.loans) {
    const d = l.derivation; const partyId = realParty(l.party.party_id);
    if (!l.existing) {
      await q.query(`INSERT INTO properties (id, address_line1, city, state, postal_code, county, property_type, occupancy, units, tax_parcel_verified) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)`,
        [l.property_id, d.property.address_line1, d.property.city, d.property.state, d.property.postal_code, d.property.county, d.property.property_type, d.property.occupancy, d.property.units]);
      // loans: status monitored, fnma_loan_number NULL, the partner's number, the MERS MIN when Luhn-valid, mers_eligible false, emortgage false, retention_class the default
      await q.query(`INSERT INTO loans (id, fnma_loan_number, servicer_loan_number, transferor_loan_number, min, mers_eligible, partner_party_id, property_id, status, lien, instrument_date, origination_date, original_upb_cents, original_term_months, first_payment_date, maturity_date, emortgage, principal_residence, default_status_at_boarding)
        VALUES ($1, NULL, $2, NULL, $3, false, $4, $5, 'monitored', $6, $7, $8, $9, $10, $11, $12, false, $13, NULL)`,
        [l.loan_id, l.row.servicer_loan_number, d.loan.min, partnerPartyId, l.property_id, d.loan.lien, d.loan.instrument_date, d.loan.origination_date, d.loan.original_upb_cents, d.loan.original_term_months, d.loan.first_payment_date, d.loan.maturity_date, d.loan.principal_residence]);
    }
    // rule 3: the party (created once per import even when two loans share it), the borrower with party_id NOT NULL, the loan_borrowers row
    if (!l.party.existing_party_id && l.party.resolution) {
      const res = l.party.resolution;
      if (res.kind === "create" && l.party.party_id.startsWith("plan:") && !partiesWritten.has(partyId)) {
        const tapeName = typeof l.row.facts["borrower_name"] === "string" && l.row.facts["borrower_name"].trim() ? l.row.facts["borrower_name"].trim() : "(unknown)";
        await q.query(`INSERT INTO parties (id, party_type, legal_name, contact) VALUES ($1, 'borrower', $2, $3::jsonb)`, [partyId, tapeName, toJson({ ...(res.email ? { email: res.email } : {}), ...(res.phone ? { phone: res.phone } : {}) })]);
        partiesWritten.add(partyId);
      } else if (res.kind === "link" && res.add_phone && !partiesWritten.has(partyId)) { await q.query(`UPDATE parties SET contact = contact || $2::jsonb WHERE id = $1`, [partyId, toJson({ phone: res.add_phone })]); partiesWritten.add(partyId); }
      if (!l.existing) {
        const tapeName = typeof l.row.facts["borrower_name"] === "string" && l.row.facts["borrower_name"].trim() ? l.row.facts["borrower_name"].trim() : "(unknown)";
        await q.query(`INSERT INTO borrowers (id, legal_name, party_id, tin_last4, date_of_birth, scra_active) VALUES ($1, $2, $3, $4, $5, false)`, [l.borrower_id, tapeName, partyId, l.row.supplement?.tin_last4 ?? null, l.row.supplement?.date_of_birth ?? null]);
        await q.query(`INSERT INTO loan_borrowers (loan_id, borrower_id, role, is_primary) VALUES ($1, $2, 'borrower', true)`, [l.loan_id, l.borrower_id]);
      } else await q.query(`UPDATE borrowers SET party_id = $2 WHERE id = $1 AND party_id IS NULL`, [l.borrower_id, partyId]);
    } else if (l.party.contact_update) {
      await q.query(`UPDATE parties SET contact = contact || $2::jsonb WHERE id = $1`, [partyId, toJson({ ...(l.party.contact_update.email ? { email: l.party.contact_update.email } : {}), ...(l.party.contact_update.phone ? { phone: l.party.contact_update.phone } : {}) })]);
    }
    // rule 2: loan_terms{source=partner_tape, effective_from=as_of}; an update closes the open row (effective_to = as_of) when the as-of is later than its effective_from — a same-day re-upload keeps the row (loan_terms_check: effective_to > effective_from)
    if (l.change === "created" || (l.change === "updated" && (l.prior_terms_from === null || l.prior_terms_from < asOf))) {
      if (l.existing) await q.query(`UPDATE loan_terms SET effective_to = $2 WHERE loan_id = $1 AND effective_to IS NULL AND effective_from < $2`, [l.loan_id, asOf]);
      const t = d.terms;
      await q.query(`INSERT INTO loan_terms (loan_id, effective_from, source, amortization, note_rate_bps, pi_cents, escrow_payment_cents, escrowed, interest_method, remittance_type, maturity_date, remaining_term_months, deferred_principal_cents, forborne_principal_cents, arm_index, arm_margin_bps, arm_lifetime_cap_bps, arm_floor_bps, arm_change_frequency_months)
        VALUES ($1, $2, 'partner_tape', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $13, $14, $15, $16, $17)`,
        [l.loan_id, asOf, t.amortization, t.note_rate_bps, t.pi_cents, t.escrow_payment_cents, t.escrowed, t.interest_method, t.remittance_type, t.maturity_date, t.remaining_term_months, t.deferred_principal_cents, t.arm_index, t.arm_margin_bps, t.arm_lifetime_cap_bps, t.arm_floor_bps, t.arm_change_frequency_months]);
    }
    // edge cases: the partner marks a loan paid or transferred on a later tape → paid_off / transferred_out with the tape's status in the event
    if (l.existing && d.status_transition) await q.query(`UPDATE loans SET status = $2 WHERE id = $1 AND status = 'monitored'`, [l.loan_id, d.status_transition]);
  }
}

/** The invitation as rows: notice_templates / notice_template_versions (the registry's, upserted so the FK holds), notices, notice_checklist_results, notice_deliveries. */
async function persistNotices(rt: Runtime, notices: NoticeService, noticeIds: readonly string[], asOf: PlainDate, q: Queryable): Promise<void> {
  if (!noticeIds.length) return;
  const repo = new PgNoticeRepository(rt.db);
  const t = rt.noticeRegistry.template(INVITATION_TEMPLATE);
  await repo.upsertTemplate(t, q);
  const v = rt.noticeRegistry.activeVersion(t.code, asOf) ?? rt.noticeRegistry.activeVersion(t.code, plainDate(rt.clock.now().slice(0, 10)));
  if (v) await repo.saveVersion(v, q);
  for (const id of noticeIds) await repo.saveNotice(notices.get(id), q);
}

export async function partnerBookReport(runtime: Runtime, importId: string): Promise<(PartnerBookImportResult & { created_at: string }) | null> {
  if (!/^[0-9a-f-]{36}$/i.test(importId)) return null;
  const row = (await runtime.db.query<ImportRow>(`SELECT ${IMPORT_COLUMNS} FROM partner_book_imports WHERE id = $1`, [importId]))[0];
  if (!row) return null;
  return { ...resultOf(row, row.status === "rejected" ? "rejected" : "loaded"), created_at: row.created_at };
}

export async function listPartnerBookImports(runtime: Runtime, partnerPartyId?: string): Promise<PartnerBookImportListing[]> {
  const rows = await runtime.db.query<PartnerBookImportListing>(`SELECT id::text AS import_id, partner_party_id::text AS partner_party_id, as_of_date::text AS as_of_date, status, rows_total, rows_loaded, loans_created, invitations_sent, created_at::text AS created_at FROM partner_book_imports WHERE ($1::uuid IS NULL OR partner_party_id = $1::uuid) ORDER BY created_at DESC LIMIT 500`, [partnerPartyId && /^[0-9a-f-]{36}$/i.test(partnerPartyId) ? partnerPartyId : null]);
  return rows.map((r) => ({ ...r, rows_total: Number(r.rows_total), rows_loaded: Number(r.rows_loaded), loans_created: Number(r.loans_created), invitations_sent: Number(r.invitations_sent) }));
}

/** Rule 7: the fixture book under the demo partner — BORROWER_DEFAULT_PARTNER_ID's party (or `opts.partner_id`) when set, else DEMO_PARTNER. Idempotent (`already_loaded` on a rerun). */
export async function seedPartnerBookDemo(runtime: Runtime, opts: { partner_id?: string } = {}): Promise<PartnerBookImportResult> {
  const configured = opts.partner_id ?? process.env["BORROWER_DEFAULT_PARTNER_ID"];
  const party = await partnerById(runtime.db, configured);
  let partner: PartnerBookImportInput["partner"] = DEMO_PARTNER;
  if (party) {
    const row = (await runtime.db.query<{ servicer_number: string | null; mers_org_id: string | null }>(`SELECT servicer_number, mers_org_id FROM parties WHERE id = $1`, [party.id]))[0];
    const entity = await runtime.entities.current("partners", party.id);
    const nmlsr = typeof entity?.data["nmlsr_id"] === "string" && entity.data["nmlsr_id"] ? String(entity.data["nmlsr_id"]) : FAKE_PARTNER_NMLSR_ID;
    partner = { legal_name: party.legal_name, nmlsr_id: nmlsr, ...(row?.servicer_number ? { servicer_number: row.servicer_number.trim() } : {}), ...(row?.mers_org_id ? { mers_org_id: row.mers_org_id.trim() } : {}) };
  }
  const book = demoBook();
  return importPartnerBook(runtime, { partner, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "partner-book-demo.xlsx", content: book.tape }, supplement: { filename: "partner-book-demo-supplement.csv", content: new Uint8Array(Buffer.from(book.supplement, "utf8")) } }, SEED_ACTOR);
}

/**
 * The breach action of SM_PARTNER_BOOK_INVITATION_REMINDER_14 (timer table: "sev 3 → portfolio (one reminder on the same channel, then
 * the clock closes)"; T10): for every breached clock whose party has no session, one reminder (`kind = reminder`) per party on the
 * channel of its first invitation (rule 4: once per provisioned party — a homeowner with two loans gets one); the reminder row is
 * the idempotency, so a second sweep sends nothing. `partner_book.invitation.sent{kind=reminder}` does not
 * re-arm (the trigger is `{kind=invitation}`). Runs from Runtime.sweep after the breach pass.
 */
export async function sendPartnerBookReminders(runtime: Runtime, nowIso: string): Promise<{ sent: number }> {
  const due = await runtime.db.query<{ timer_id: string; loan_id: string; import_id: string; party_id: string; channel: "email" | "sms"; servicer_loan_number: string; partner_legal_name: string; display_name: string; contact: Record<string, unknown> }>(
    `SELECT DISTINCT ON (i.party_id) t.id AS timer_id, t.loan_id::text AS loan_id, i.import_id::text AS import_id, i.party_id::text AS party_id, i.channel, l.servicer_loan_number, pp.legal_name AS partner_legal_name, p.legal_name AS display_name, p.contact
       FROM timers t
       JOIN partner_book_invitations i ON i.loan_id = t.loan_id AND i.kind = 'invitation'
       JOIN loans l ON l.id = t.loan_id
       JOIN parties pp ON pp.id = l.partner_party_id
       JOIN parties p ON p.id = i.party_id
      WHERE t.code = 'SM_PARTNER_BOOK_INVITATION_REMINDER_14' AND t.status = 'breached' AND t.breached_at <= $1
        AND NOT EXISTS (SELECT 1 FROM partner_book_invitations r WHERE r.party_id = i.party_id AND r.kind = 'reminder')
        AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.party_id = i.party_id)
        AND NOT EXISTS (SELECT 1 FROM loan_events a WHERE a.type = 'partner_book.account.activated' AND a.payload->>'party_id' = i.party_id::text)
      ORDER BY i.party_id, i.sent_at, i.loan_id`, [nowIso]);
  let sent = 0;
  for (const row of due) {
    const d = contactDestinations(row.contact);
    const destination = row.channel === "email" ? d.emails[0] ?? null : d.phones[0] ?? null;
    if (!destination) continue;
    const consentId = row.channel === "sms" ? (await runtime.db.query<{ id: string }>(`SELECT id FROM consents WHERE kind = 'tcpa_sms' AND granted AND revoked_at IS NULL AND status = 'active' AND (party_id = $1::uuid OR channel_identifier = $2) ORDER BY captured_at DESC LIMIT 1`, [row.party_id, destination]))[0]?.id ?? null : null;
    if (row.channel === "sms" && !consentId) continue;   // NO_TCPA_EVIDENCE: a consent revoked since the invitation stops the text
    if (!runtime.ports.edelivery || !runtime.ports.printMail) break;
    const overrides = new Map<string, InvitationSubject>();
    const edelivery = invitationEdelivery(runtime.ports.edelivery, overrides);
    const noticeIds: string[] = [];
    let notices: NoticeService | undefined;
    const inv: InvitationInput = { import_id: row.import_id, party_id: row.party_id, loan_id: row.loan_id, kind: "reminder", channel: row.channel, destination, display_name: row.display_name, partner_legal_name: row.partner_legal_name, servicer_loan_number: row.servicer_loan_number, consent_id: consentId };
    let res: Awaited<ReturnType<typeof sendInvitation>> | undefined;
    await runtime.uow.run({ loanId: row.loan_id }, async (ctx) => {
      notices = new NoticeService({ registry: runtime.noticeRegistry, events: ctx.events, clock: ctx.clock, printMail: runtime.ports.printMail!, edelivery, notices: runtime.noticeMemory });
      res = await sendInvitation({ notices, edelivery, events: ctx.events, clock: ctx.clock, actor: PORTFOLIO_AGENT, overrides }, inv);
      inviteDecision(ctx, inv, res);
      noticeIds.push(res.notice_id);
    }, { clock: runtime.clock, commit: async (q) => {
      // the reminder row (the idempotency: a second sweep finds it and sends nothing) and the notice rows, in the same transaction as the events
      if (!res || res.held_reason) return;
      await q.query(`INSERT INTO partner_book_invitations (id, import_id, party_id, loan_id, channel, destination_hash, notice_id, message_id, sent_at, kind, bounced_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reminder', $10)`, [randomUUID(), row.import_id, row.party_id, row.loan_id, row.channel, res.destination_hash, res.notice_id, res.message_id, res.sent_at, res.bounced ? res.sent_at : null]);
      if (notices) await persistNotices(runtime, notices, noticeIds, plainDate(nowIso.slice(0, 10)), q);
    } });
    if (!res || res.held_reason) { runtime.logger?.warn("partner book reminder held", { timer_id: row.timer_id, loan_id: row.loan_id, party_id: row.party_id, reason: res?.held_reason ?? "not rendered" }); continue; }
    sent++;
    runtime.logger?.info("partner book reminder sent", { timer_id: row.timer_id, loan_id: row.loan_id, party_id: row.party_id, channel: row.channel, loan_last4: lastFour(row.servicer_loan_number), destination_hash: res.destination_hash });
  }
  return { sent };
}
