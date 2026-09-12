/**
 * A servicing book for the runtime's daily passes, on a database of its own: the worked-example loan of 20.1 ($565,000
 * / 7.000 % / 360, note Fri Sept 18, 2024, Phoenix AZ) boarded through the journey fixture's `seedBook` + `adoptPriorLoan`
 * with a signed-in borrower party on it, the 32.14 demo seed (the partner's program, 20.4's matrix, the FAKE cost schedule,
 * an active sheet, the FAKE demo MLO the 32.11 flow names as the MLO of record), and the loan's vendor facts (the AVM value
 * $800,000, score 765 on file) loaded through `20.1 loadUniverse{op=load_row}` — a row whose data names the loan is the
 * loan's, the scope the daily run's `load_row` writes in too. Used by src/runtime/refi-daily.test.ts and src/runtime/reviewers.test.ts.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, type Db } from "../../../infra/db/client.ts";
import { decodeEntityData } from "../../../infra/db/entities.ts";
import { FixedClock } from "../../../kernel/events/index.ts";
import { loadOverriddenRegistry } from "../../../domain/timer-overrides.ts";
import type { RateFeedPort } from "../../../infra/integrations/rates.ts";
import type { FakeReviewers } from "../../../infra/integrations/reviewers.ts";
import { Runtime } from "../../app.ts";
import { createApiServer, listen } from "../../server.ts";
import { createLogger, type Logger } from "../../log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../routes.ts";
import { seedEntryDemo } from "../../entry-seed.ts";
import { Journey } from "./journey.ts";

type P = Record<string, unknown>;
export interface CardRow { card_instance_id: string; party_id: string; kind: string; status: string; copy_key: string; props: P; command_ref: string | null; created_at: string; created_by: string; subject_loan_id: string | null }
export interface RefiBook {
  readonly db: Db; readonly runtime: Runtime; readonly router: BorrowerRouter; readonly base: string; readonly token: string; readonly clock: FixedClock; readonly journey: Journey; readonly lines: string[];
  readonly partnerPartyId: string; readonly partnerName: string; readonly borrowerEmail: string; readonly partyId: string; readonly loanId: string; readonly programId: string;
  settle(): Promise<void>; signIn(email?: string): Promise<{ token: string; party_id: string }>; api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: P }>;
  loanEvents(type?: string): Promise<{ type: string; occurred_at: string; actor_kind: string; actor_id: string; payload: P }[]>; cards(partyId?: string): Promise<CardRow[]>; timers(code: string): Promise<{ id: string; status: string; due_at: string | null; subject_kind: string; subject_id: string }[]>; entity(kind: string, id: string): Promise<P | null>;
  close(): Promise<void>;
}
export interface RefiBookOptions { readonly dbUrl: string; readonly clock: FixedClock; readonly rateFeed?: RateFeedPort | null; readonly reviewers?: FakeReviewers | null; readonly logger?: Logger; /** the servicing facts on the vendor row as of Oct 1, 2026 (a book the daily run already refreshed) instead of the boarding-day ones */ readonly currentFacts?: boolean }

/** JSON's decimal-string cents → bigint at any depth (what the HTTP path's `toolInput` does; an in-process execute must do it itself). */
export const reviveCents = (v: unknown): unknown => Array.isArray(v) ? v.map(reviveCents) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as P).map(([k, x]) => [k, k.endsWith("_cents") && (typeof x === "string" || typeof x === "number") && x !== "" ? BigInt(x) : reviveCents(x)])) : v;
/** 20.1 worked example 1's vendor facts for the prior loan (what an AVM / the origination file put on record) with the servicing facts as they stood at boarding (no payment made yet) — the daily run re-derives those from the view (24 payments made by Oct 1, 2026; UPB $553,106.41; 336 months left). */
export const WORKED_EXAMPLE_VENDOR_ROW = (loanId: string, partnerId: string, o: { current?: boolean } = {}): P => reviveCents({ loan_id: loanId, partner_id: partnerId, status: "active", product_code: "FRM30", amortization: "fixed", note_date: "2024-09-18", first_payment_date: "2024-11-01", consummation_date: "2024-09-18", title_date: "2019-06-14",
  original_upb_cents: "56500000", original_term_months: 360, note_rate_pct: "7.000", pi_cents: "375896", ...(o.current ? { payments_made: 24, upb_cents: "55310641", next_due_date: "2026-11-01", remaining_term_months: 336 } : { payments_made: 0, upb_cents: "56500000", next_due_date: "2024-11-01", remaining_term_months: 360 }),
  escrowed: true, escrow_monthly_cents: "68750", net_escrow_deposit_estimate_cents: "300000", taxes_annual_cents: "480000", insurance_annual_cents: "186000", mi_status: "none", mi_monthly_cents: "0", occupancy: "primary", property_type: "sfr", units: 1, property_state: "AZ", county: "Maricopa", county_limit_cents: "83275000",
  value_estimate: { source: "origination_indexed", value_cents: "80000000", as_of: "2026-09-30", confidence: "high" }, representative_score: 765, score_source: "origination_file",
  regx_days_delinquent: 0, bankruptcy_active: false, foreclosure_referred: false, lossmit_plan_active: false, deceased_or_sii_pending: false, transfer_out_pending: false, refi_do_not_solicit: false, refi_last_offered_at: null, refi_offers_12m: 0, arm_first_adjustment_date: null }) as P;

export async function openRefiBook(o: RefiBookOptions): Promise<RefiBook> {
  const name = new URL(o.dbUrl).pathname.slice(1); const admin = new URL(o.dbUrl); admin.pathname = "/postgres";
  const a = connect(admin.toString()); await a.query(`DROP DATABASE IF EXISTS ${name}`); await a.query(`CREATE DATABASE ${name}`); await a.end();
  execFileSync(fileURLToPath(new URL("../../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: o.dbUrl }, stdio: "pipe" });
  const db = connect(o.dbUrl);
  const lines: string[] = [];
  const logger = o.logger ?? createLogger("json", (line) => { lines.push(line); if (process.env["FLOW_DEBUG"] && /flow|error|refi|fake|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  const runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock: o.clock, rateFeed: o.rateFeed ?? null, reviewers: o.reviewers ?? null, logger });
  const token = "ops-" + randomUUID();
  const partnerName = `Partner Bank ${randomUUID().slice(0, 8)}`;
  const partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [partnerName]))[0]!.id;
  const router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret", defaultPartnerId: partnerPartyId });
  const server = createApiServer({ runtime, apiToken: token, logger, console: false, borrowerRouter: router });
  const base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  const api = async (method: string, path: string, body?: unknown, tok?: string): Promise<{ status: number; body: P }> => {
    const r = await fetch(base + path, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as P) : {} };
  };
  const borrowerEmail = `alex-${randomUUID().slice(0, 8)}@example.test`;
  const signIn = async (email = borrowerEmail): Promise<{ token: string; party_id: string }> => {
    const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email });
    const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] });
    assert.equal(ver.status, 200, JSON.stringify(ver.body));
    return { token: ver.body["token"] as string, party_id: (ver.body["party"] as { party_id: string }).party_id };
  };
  // the book: custodial accounts, the property, the prior loan; the borrower party adopts it (loan_terms, loan_borrowers) — the fixture's ×10-short bps and the worked example's P&I corrected on the terms row
  const journey = new Journey({ runtime, db, base, token, clock: o.clock, borrowerEmail, coBorrowerEmail: `blake-${randomUUID().slice(0, 8)}@example.test`, partnerPartyId });
  await journey.seedBook();
  const partyId = (await signIn()).party_id;
  const loanId = await journey.adoptPriorLoan(partyId);
  await db.query(`UPDATE loan_terms SET note_rate_bps = 70000, pi_cents = 375896, remaining_term_months = NULL WHERE loan_id = $1`, [loanId]);
  // the 32.14 demo seed: the partner's program, the LLPA matrix, the FAKE cost schedule, an active sheet, and the roster row (M-FAKE-DEMO, "A. Lee (FAKE demo MLO)", NMLSR 222333) 32.11's `mloOfRecord` names for AZ
  const seeded = await seedEntryDemo(runtime, { partner_id: partnerPartyId, states: ["AZ"], now: o.clock.now() });
  const programId = seeded.refi.find((x) => x.startsWith("partner_programs/"))!.slice("partner_programs/".length);
  // the loan's vendor facts on record, in the daily run's (global) scope
  await runtime.execute({ process: "20.1", name: "loadUniverse", loanId: "", actor: { kind: "agent", id: "intake" }, input: { op: "load_row", row: WORKED_EXAMPLE_VENDOR_ROW(loanId, partnerPartyId, { current: o.currentFacts === true }), program_id: programId, gate_facts: { fnma_purchase_date: null, declined_on: null, offered_at: [] } } });
  await router.flows!.settle();
  const settle = () => router.flows!.settle();
  const CARD_COLS = "card_instance_id, party_id, kind, status, copy_key, props, command_ref, created_at, created_by, subject_loan_id";
  return {
    db, runtime, router, base, token, clock: o.clock, journey, lines, partnerPartyId, partnerName, borrowerEmail, partyId, loanId, programId, settle, signIn, api,
    loanEvents: (type?: string) => db.query(`SELECT type, occurred_at, actor_kind, actor_id, payload FROM loan_events WHERE loan_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [loanId, type ?? null]),
    cards: async (pid?: string) => { await settle(); return db.query<CardRow & P>(`SELECT ${CARD_COLS} FROM card_instances WHERE subject_loan_id = $1 AND ($2::uuid IS NULL OR party_id = $2) ORDER BY created_at, card_instance_id`, [loanId, pid ?? null]); },
    timers: (code: string) => db.query(`SELECT id, status::text AS status, due_at, subject_kind, subject_id FROM timers WHERE code = $1 ORDER BY armed_at`, [code]),
    entity: async (kind: string, id: string) => { const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; },
    close: async () => { await settle(); await new Promise<void>((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); }); },
  };
}
