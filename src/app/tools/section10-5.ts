/**
 * §10.5 process-owned tools — additional bus tools for 10.5 defined with `defineTools("10.5", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section10.ts). Every tool string must be one
 * spec/registry/agents.json names for 10.5; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 *
 *   investor_events.emit  op `escrow_event`      the refund deposit/disbursement leg (from `mi.refund.posted`) submitted as an
 *                                                LL-2026-05 escrow event (Taxes & Insurance) → `escrow.event.submitted` with the
 *                                                03:00 ET next-Fannie-business-day deadline (spec 10.5 "Investor reporting")
 *                         op `escrow_event_ack`  Fannie Mae's acknowledgement record ingested → `escrow.event.accepted`
 *                                                (satisfies LL_2026_05_ESCROW_EVENT_3AM) or `escrow.event.rejected` (3.7 correction)
 */
import { defineTools, compute, cents, str, type ToolDef, type ToolInput } from "../tools.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { ingestEscrowEventAck, submitRefundEscrowEvent } from "../../domain/pmi/ops-10-5.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };

/** `ledger.post` ops `escrow_event` / `escrow_event_ack` for 10.5 (spliced into the shared ledger.post tool by ./section10.ts). */
export const escrowEventOp_10_5 = compute((i, ctx, rt) => {
      const op = str(i, "op") || "escrow_event";
      if (op === "escrow_event_ack") { need(i, "ack"); return ingestEscrowEventAck(ctx, rt, i.ack); }
      if (op !== "escrow_event") throw new RangeError(`investor_events.emit op ${op} is not escrow_event/escrow_event_ack (10.5)`);
      need(i, "loan_id", "kind", "amount_cents", "posted_on");
      const kind = str(i, "kind"); if (kind !== "deposit" && kind !== "disbursement") throw new RangeError(`kind ${kind} is not deposit/disbursement`);
      return submitRefundEscrowEvent(ctx, rt, { loan_id: str(i, "loan_id"), kind, amount_cents: cents(i.amount_cents), posted_on: D(str(i, "posted_on")),
        ...(i.balance_cents !== undefined && i.balance_cents !== null ? { balance_cents: cents(i.balance_cents) } : {}), refund_id: (i.refund_id as string | undefined) ?? null, disbursement_id: (i.disbursement_id as string | undefined) ?? null });
    });
/** agents.json names no `investor_events.*` tool for 10.5: the escrow-event leg is exposed through `ledger.post` (see section10.ts). */
export const TOOLS_10_5: readonly ToolDef[] = [];
