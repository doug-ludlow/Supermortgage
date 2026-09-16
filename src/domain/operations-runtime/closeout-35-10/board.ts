/**
 * §35.10 rule 11 — the board is a receipt: the counts of refinance_closeouts by mode, step and wait, the day's retirements,
 * completions and unwinds, releases open and partners unconfirmed. `renderRefinanceBoard` is the text 35.8's Refinance board
 * shows (and the receipt document stores); it prints the receipt's counts and the open rows, never a figure of its own.
 */
import type { ReceiptCounts } from "./types.ts";

export interface BoardRow { readonly application_id: string; readonly prior_loan_id: string; readonly mode: string; readonly step: string; readonly status: string; readonly waiting_on: string | null; readonly opened_at: string; readonly good_through: string | null; readonly disbursement_date: string | null; }
export function renderRefinanceBoard(asOf: string, c: ReceiptCounts, rows: readonly BoardRow[]): string {
  const kv = (o: Record<string, number>): string => Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(" ") || "-";
  const lines = [
    `REFINANCE BOARD — ${asOf}`,
    `open ${c.open} | by mode ${kv(c.by_mode)} | by step ${kv(c.by_step)}`,
    `waiting human ${c.waiting_human} | waiting vendor ${c.waiting_vendor} | waiting partner ${c.waiting_partner} | held ${c.held}`,
    `retired today ${c.retired_today} | completed today ${c.completed_today} | unwound today ${c.unwound_today}`,
    `releases open ${c.releases_open} | partners unconfirmed ${c.partner_unconfirmed} | oldest open ${c.oldest_open_step ?? "-"} (${c.oldest_open_days ?? 0} days)`,
    "",
    "application | prior loan | mode | step | status | waiting on | good through | disbursement",
    ...rows.map((r) => `${r.application_id.slice(0, 8)} | ${r.prior_loan_id.slice(0, 8)} | ${r.mode} | ${r.step} | ${r.status} | ${r.waiting_on ?? "-"} | ${r.good_through ?? "-"} | ${r.disbursement_date ?? "-"}`),
  ];
  return lines.join("\n");
}
