/**
 * §35.12 — the narrow ports on sibling processes, each with an in-repo default so this process runs (and its tests pass) whether or
 * not the neighbour has merged (35.7's roles-35-7/ports.ts pattern):
 *   35.5 / 35.1  OurFiguresPort — the eight reconciliation fields of a loan as of a day, from the typed rows (rule 7). The default reads
 *                `loans`, `loan_installments`, `fees` and the ledger as they exist at HEAD; 35.5's installment schedule replaces it.
 *   35.4         CloseAttestationsPort — the month-end close attestations (GL-10); the default reads `close_attestations` when it exists.
 *   35.2         RetentionMatrixPort — the counsel-signed retention matrix and the bucket lock (GL-07); the default reads a `documents` row
 *                of kind `retention_matrix` with metadata.signed_by_role = counsel and metadata.bucket_lock_applied = true.
 *   35.11        OpsDailyReportsPort — `ops_daily_reports{environment, as_of_date, fake_approvals}` (GL-11); the default reads the table when it exists.
 *   35.5 / 35.9  ServicingConfigPort — per-loan zone and servicer identity from configuration (GL-09); the default reads
 *                `loan_servicing_configs` and `servicer_profiles` when they exist and answers the missing tables otherwise.
 *   this process UnverifiedConfirmationsPort — the signed confirmation documents of the [UNVERIFIED] items (GL-12): `documents` rows of kind
 *                `unverified_confirmation` with metadata.item_key ∈ UNVERIFIED_ITEMS (35.2 and 35.7 add their keys through the port).
 * A test injects ports with `setPosturePorts(runtime, …)` (keyed by the root runtime, so a command view sees them too).
 */
import type { Queryable } from "../../../infra/db/client.ts";
import type { Runtime } from "../../../runtime/app.ts";

export interface OurFigures { readonly upb_cents: bigint; readonly escrow_balance_cents: bigint; readonly next_due_date: string | null; readonly late_charges_accrued_cents: bigint; readonly interest_paid_ytd_cents: bigint; readonly amount_due_cents: bigint; readonly days_delinquent: number; readonly form_496_remittance_cents: bigint }
export interface OurFiguresPort { figures(q: Queryable, loanId: string, asOf: string): Promise<OurFigures | null> }
export interface CloseAttestation { readonly id: string; readonly period: string; readonly attested_at: string }
export interface CloseAttestationsPort { attestations(q: Queryable, environment: string, since: string): Promise<readonly CloseAttestation[]> }
export interface RetentionMatrixPort { signed(q: Queryable): Promise<{ document_id: string; signed_by_role: string; bucket_lock_applied: boolean } | null> }
export interface OpsDailyReport { readonly id: string; readonly as_of_date: string; readonly fake_approvals: number }
export interface OpsDailyReportsPort { reports(q: Queryable, environment: string, since: string): Promise<readonly OpsDailyReport[]> }
export interface ServicingConfigPort { status(q: Queryable): Promise<{ config_rows: number; profile_rows: number; loans_without_config: number; missing_tables: string[] }> }
export interface UnverifiedConfirmationsPort { confirmations(q: Queryable): Promise<readonly { item_key: string; document_id: string }[]> }
export interface PosturePorts { readonly ourFigures?: OurFiguresPort; readonly closeAttestations?: CloseAttestationsPort; readonly retentionMatrix?: RetentionMatrixPort; readonly opsDailyReports?: OpsDailyReportsPort; readonly servicingConfig?: ServicingConfigPort; readonly unverifiedConfirmations?: UnverifiedConfirmationsPort }

/** The [UNVERIFIED] items this process and 35.2/35.7 name (GL-12: each needs a signed confirmation document). */
export const UNVERIFIED_ITEMS: readonly string[] = ["35.12/nydfs-500-16d-quarterly-policy", "35.12/parallel-run-policy", "35.12/gcp-terraform-attributes", "35.12/cloudsql-admin-api", "35.12/gcp-terraform-facts-fields", "35.12/incumbent-trial-balance-format", "35.12/vendor-canary", "35.12/secret-age-policy", "35.12/keyed-subject-override", "35.2/retention-matrix-unverified", "35.7/identity-provider-unverified"];

const exists = async (q: Queryable, table: string): Promise<boolean> => (await q.query<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [`public.${table}`]))[0]?.r !== null;
/**
 * A read over a sibling process's table in its own savepoint: the ports run inside the caller's unit of work (go_live.check's command), where a
 * failed statement leaves the transaction aborted and every later read fails with 25P02 (`current transaction is aborted`) — the 35.3 `rowsOf`
 * lesson; a plain try/catch cannot recover it. Outside a transaction the SAVEPOINT is refused and the read runs bare. A failed read is the
 * fallback (an item stays `open`), never a failed checklist.
 */
async function guarded<T>(q: Queryable, fallback: T, read: () => Promise<T>): Promise<T> {
  const sp = await q.query(`SAVEPOINT posture_port`).then(() => true, () => false);
  try { const out = await read(); if (sp) await q.query(`RELEASE SAVEPOINT posture_port`); return out; }
  catch { if (sp) await q.query(`ROLLBACK TO SAVEPOINT posture_port`).catch(() => undefined); return fallback; }
}
const big = (v: unknown): bigint => (v === null || v === undefined ? 0n : BigInt(String(v)));

export const defaultOurFigures: OurFiguresPort = {
  async figures(q, loanId, asOf) {
    const [loan] = await q.query<{ id: string; original_upb_cents: string }>(`SELECT id::text AS id, original_upb_cents::text AS original_upb_cents FROM loans WHERE id = $1`, [loanId]);
    if (!loan) return null;
    const inst = await q.query<{ due_date: string; pi_cents: string; interest_cents: string; principal_cents: string; escrow_cents: string; status: string; satisfied_on: string | null }>(`SELECT due_date::text AS due_date, pi_cents::text AS pi_cents, interest_cents::text AS interest_cents, principal_cents::text AS principal_cents, escrow_cents::text AS escrow_cents, status::text AS status, satisfied_on::text AS satisfied_on FROM loan_installments WHERE loan_id = $1 ORDER BY due_date`, [loanId]);
    const paid = inst.filter((i) => i.satisfied_on !== null && i.satisfied_on <= asOf);
    const open = inst.filter((i) => i.due_date <= asOf && (i.satisfied_on === null || i.satisfied_on > asOf));
    const upb = big(loan.original_upb_cents) - paid.reduce((s, i) => s + big(i.principal_cents), 0n);
    const [esc] = await q.query<{ bal: string | null }>(`SELECT coalesce(sum(l.amount_cents), 0)::text AS bal FROM ledger_lines l JOIN ledger_entry_sets s ON s.id = l.set_id WHERE l.loan_id = $1 AND l.account LIKE 'escrow%' AND s.effective_date <= $2::date`, [loanId, asOf]);
    const [lc] = await q.query<{ due: string | null }>(`SELECT coalesce(sum(amount_cents - coalesce(collected_cents, 0) - coalesce(waived_cents, 0)), 0)::text AS due FROM fees WHERE loan_id = $1 AND fee_type::text = 'late_charge' AND assessed_on IS NOT NULL AND assessed_on <= $2::date AND state::text NOT IN ('waived', 'reversed', 'suppressed')`, [loanId, asOf]);
    const nextDue = inst.find((i) => i.satisfied_on === null || i.satisfied_on > asOf)?.due_date ?? null;
    const oldestOpen = open[0]?.due_date ?? null;
    const daysDelinquent = oldestOpen ? Math.max(0, Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${oldestOpen}T00:00:00Z`)) / 86_400_000)) : 0;
    return { upb_cents: upb, escrow_balance_cents: big(esc?.bal), next_due_date: nextDue, late_charges_accrued_cents: big(lc?.due), interest_paid_ytd_cents: paid.filter((i) => i.satisfied_on!.slice(0, 4) === asOf.slice(0, 4)).reduce((s, i) => s + big(i.interest_cents), 0n), amount_due_cents: open.reduce((s, i) => s + big(i.pi_cents) + big(i.escrow_cents), 0n), days_delinquent: daysDelinquent, form_496_remittance_cents: 0n };
  },
};
export const defaultCloseAttestations: CloseAttestationsPort = {
  async attestations(q, _environment, since) {
    if (!(await exists(q, "close_periods"))) return [];
    // 35.4's rows (db/migrations/0180): a month-end close is one `close_periods` row of kind `month` (period YYYY-MM, one per servicer number) that reached
    // `attested` — 35.4 attest.ts patches `status`, `attested_at` and `current_attestation_id` when every P&I unit's `balance` attestation is in — so GL-10's
    // "two month-end closes" are two periods, never two `close_attestations` rows of one period (one per custodial account and remittance type: a single
    // October close over two accounts writes two); a `closed` period was attested first and still counts, a `reopened` one does not until it is re-attested.
    // The id is the period's current attestation (T15: "GL-10 the two 35.4 attestations"); the runtime's own database is the environment's (no environment column)
    return guarded(q, [], async () => (await q.query<{ id: string; period: string; attested_at: string }>(`SELECT DISTINCT ON (p.period) coalesce(p.current_attestation_id, p.id)::text AS id, p.period::text AS period, p.attested_at::text AS attested_at FROM close_periods p WHERE p.kind = 'month' AND p.status IN ('attested', 'closed') AND p.attested_at IS NOT NULL AND p.attested_at >= $1::timestamptz ORDER BY p.period, p.attested_at DESC`, [since])).map((r) => ({ id: r.id, period: r.period, attested_at: r.attested_at })));
  },
};
export const defaultRetentionMatrix: RetentionMatrixPort = {
  async signed(q) {
    const [d] = await q.query<{ id: string; metadata: Record<string, unknown> }>(`SELECT id::text AS id, metadata FROM documents WHERE kind = 'retention_matrix' AND metadata->>'signed_by_role' = 'counsel' ORDER BY created_at DESC LIMIT 1`);
    return d ? { document_id: d.id, signed_by_role: String(d.metadata["signed_by_role"]), bucket_lock_applied: d.metadata["bucket_lock_applied"] === true } : null;
  },
};
export const defaultOpsDailyReports: OpsDailyReportsPort = {
  async reports(q, environment, since) {
    if (!(await exists(q, "ops_daily_reports"))) return [];
    // 35.11's rows (db/migrations/0230): one hashed row per environment-day per distinct content — the newest row of each day is the day's report
    return guarded(q, [], async () => (await q.query<{ id: string; as_of_date: string; fake_approvals: string }>(`SELECT DISTINCT ON (as_of_date) id::text AS id, as_of_date::text AS as_of_date, fake_approvals::text AS fake_approvals FROM ops_daily_reports WHERE environment = $1 AND as_of_date >= $2::date ORDER BY as_of_date, created_at DESC`, [environment, since])).map((r) => ({ id: r.id, as_of_date: r.as_of_date, fake_approvals: Number(r.fake_approvals) })));
  },
};
export const defaultServicingConfig: ServicingConfigPort = {
  async status(q) {
    const missing = (await Promise.all(["loan_servicing_configs", "servicer_profiles"].map(async (t) => ((await exists(q, t)) ? null : t)))).filter((x): x is string => !!x);
    if (missing.length) return { config_rows: 0, profile_rows: 0, loans_without_config: -1, missing_tables: missing };
    return guarded(q, { config_rows: 0, profile_rows: 0, loans_without_config: -1, missing_tables: ["loan_servicing_configs?"] }, async () => {
      const [c] = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_servicing_configs`); const [p] = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM servicer_profiles`);
      const [w] = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM loans l WHERE l.status::text IN ('active', 'boarded') AND NOT EXISTS (SELECT 1 FROM loan_servicing_configs c WHERE c.loan_id = l.id)`);
      return { config_rows: Number(c!.n), profile_rows: Number(p!.n), loans_without_config: Number(w!.n), missing_tables: [] };
    });
  },
};
export const defaultUnverifiedConfirmations: UnverifiedConfirmationsPort = {
  async confirmations(q) { return q.query<{ item_key: string; document_id: string }>(`SELECT DISTINCT ON (metadata->>'item_key') metadata->>'item_key' AS item_key, id::text AS document_id FROM documents WHERE kind = 'unverified_confirmation' AND metadata->>'signed_by_role' IS NOT NULL ORDER BY metadata->>'item_key', created_at DESC`); },
};
const registry = new WeakMap<object, PosturePorts>();
export function setPosturePorts(rt: Runtime, ports: PosturePorts | null): void { const key = (rt as { root?: Runtime }).root ?? rt; if (ports) registry.set(key, ports); else registry.delete(key); }
export function posturePortsOf(rt: Runtime): Required<PosturePorts> {
  const p = registry.get((rt as { root?: Runtime }).root ?? rt) ?? {};
  return { ourFigures: p.ourFigures ?? defaultOurFigures, closeAttestations: p.closeAttestations ?? defaultCloseAttestations, retentionMatrix: p.retentionMatrix ?? defaultRetentionMatrix, opsDailyReports: p.opsDailyReports ?? defaultOpsDailyReports, servicingConfig: p.servicingConfig ?? defaultServicingConfig, unverifiedConfirmations: p.unverifiedConfirmations ?? defaultUnverifiedConfirmations };
}
