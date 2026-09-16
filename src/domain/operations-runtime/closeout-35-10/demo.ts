/**
 * §35.10 — the demo book's closeouts: one refinance application per mode × step so the Refinance board (35.8) and its daily
 * receipt (T15) have something to count. Rows only (no owner tool runs): the demo states the platform's own tables, never a figure.
 * Idempotent per (partner, mode, step): a second seed writes nothing; a second partner gets its own book (the servicer loan number carries the partner).
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { STEP_ORDER, type CloseoutMode, type CloseoutStatus, type CloseoutStep } from "./types.ts";

const STATUS_FOR: Partial<Record<CloseoutStep, CloseoutStatus>> = { awaiting_schedule: "open", quoted: "waiting_window", settling: "open", settled: "open", escrow_disposed: "open", retired: "open", released_or_confirmed: "waiting_human", linked: "open", completed: "completed" };
export interface DemoCloseout { readonly application_id: string; readonly prior_loan_id: string; readonly mode: CloseoutMode; readonly step: CloseoutStep; }
/** Seeds `partner_party_id`'s demo closeouts (a prior loan and an application per row) at `now`. */
export async function seedDemoCloseouts(q: Queryable, partnerPartyId: string, now: string, opts: { propertyId?: string } = {}): Promise<DemoCloseout[]> {
  const out: DemoCloseout[] = [];
  const propertyId = opts.propertyId ?? (await q.query<{ id: string }>(`INSERT INTO properties (address_line1, city, state, postal_code) VALUES ('1 Demo Refinance Way', 'Phoenix', 'AZ', '85004') RETURNING id::text AS id`))[0]!.id;
  for (const mode of ["serviced_same_servicer", "monitored_partner"] as const) {
    for (const step of STEP_ORDER) {
      if (step === "opened") continue;
      const number = `DEMO-CO-${partnerPartyId.slice(0, 8)}-${mode === "serviced_same_servicer" ? "S" : "M"}-${step}`;   // one demo book per partner: the servicer number carries the partner
      const existing = (await q.query<{ application_id: string; prior_loan_id: string }>(`SELECT c.application_id::text AS application_id, c.prior_loan_id::text AS prior_loan_id FROM refinance_closeouts c JOIN loans l ON l.id = c.prior_loan_id WHERE l.servicer_loan_number = $1 AND l.partner_party_id = $2`, [number, partnerPartyId]))[0];
      if (existing) { out.push({ ...existing, mode, step }); continue; }
      const priorStatus = mode === "serviced_same_servicer" ? "active" : "monitored";
      const retired = step === "retired" || step === "released_or_confirmed" || step === "linked" || step === "completed";
      const loan = (await q.query<{ id: string }>(`INSERT INTO loans (fnma_loan_number, servicer_loan_number, partner_party_id, property_id, status, instrument_date, original_upb_cents, original_term_months, first_payment_date, maturity_date) VALUES ($1, $2, $3, $4, $5::loan_status, '2024-09-20', 45000000, 360, '2024-11-01', '2054-10-01') RETURNING id::text AS id`,
        [mode === "serviced_same_servicer" ? String(7_000_000_000 + Math.floor(Math.random() * 999_999_999)) : null, number, partnerPartyId, propertyId, retired ? "paid_off" : priorStatus]))[0]!.id;
      const app = (await q.query<{ id: string }>(`INSERT INTO applications (id, partner_party_id, channel, transaction_type, occupancy, status, prior_loan_id, application_date) VALUES ($1, $2, 'refi_trigger', 'limited_cash_out', 'primary', $3, $4, $5::date) RETURNING id::text AS id`, [randomUUID(), partnerPartyId, retired ? "funded" : "received", loan, now.slice(0, 10)]))[0]!.id;
      const status = STATUS_FOR[step] ?? "open";
      const waitingOn = step === "released_or_confirmed" ? (mode === "serviced_same_servicer" ? "signing_officer" : "partner") : step === "quoted" ? "rescission_window" : null;
      await q.query(`INSERT INTO refinance_closeouts (id, application_id, prior_loan_id, partner_party_id, mode, prior_status_at_open, step, status, waiting_on, opened_at, updated_at, retired_at, completed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12)`,
        [randomUUID(), app, loan, partnerPartyId, mode, priorStatus, step, status, mode === "monitored_partner" && step === "released_or_confirmed" ? "partner" : waitingOn, now, retired ? now : null, step === "completed" ? now : null]);
      if (mode === "monitored_partner" && step === "released_or_confirmed") await q.query(`UPDATE refinance_closeouts SET status = 'waiting_partner' WHERE application_id = $1`, [app]);
      out.push({ application_id: app, prior_loan_id: loan, mode, step });
    }
  }
  return out;
}
