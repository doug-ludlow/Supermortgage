/**
 * §9.2 process-owned tools — the bus tools for 9.2 defined with `defineTools("9.2", <agent>, defs)` from ../tools.ts
 * (moved here from ./section09.ts). Every tool string must be one spec/registry/agents.json names for 9.2
 * (`assessReasonableBasis`, `checkEscrowGuard`); src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 *
 * Both tools are thin shells over the 9.2 case service (src/domain/insurance/ops-9-2.ts, wired as
 * `rt.services.fpi`): the basis assessment records the reasonable basis on the case (rule 1 — no notice without a
 * recorded basis), and the escrow guard reports the §1024.17(k)(5) evaluation behind `REGX_1024_17K5_LPI_PURCHASE_GATE`.
 */
import { defineTools, compute, never, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { evaluateGate } from "../evaluators.ts";
import { reasonableBasis, escrowGuard, type BasisKind } from "../../domain/insurance/fpi.ts";
import type { Deficiency } from "../../domain/insurance/hazard.ts";
import { Fpi92Service } from "../../domain/insurance/ops-9-2.ts";

const A = "insurance-property";
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
/** The 9.2 case service a runtime wires in (`services.fpi`), if any. */
export const fpiService = (rt: ToolRuntime): Fpi92Service | undefined => (rt.services.fpi instanceof Fpi92Service ? rt.services.fpi : undefined);
const reason = (i: ToolInput): "nonpayment" | "underwriting" | "other" | null => (i.cancellation_reason === "nonpayment" || i.cancellation_reason === "underwriting" || i.cancellation_reason === "other" ? i.cancellation_reason : null);

export const TOOLS_9_2: readonly ToolDef[] = defineTools("9.2", A, [
  { name: "assessReasonableBasis", kind: "write", handler: compute((i, _ctx, rt) => { need(i, "kind"); const kind = str(i, "kind") as BasisKind; const deficiency = i.deficiency as Deficiency | undefined;
      const ok = reasonableBasis(kind, deficiency);
      const svc = fpiService(rt);
      const recorded = ok && flag(i, "record") && svc && str(i, "case_id") ? svc.recordBasis(str(i, "case_id"), { kind, evidence_id: str(i, "basis_evidence_id"), ...(deficiency !== undefined ? { deficiency } : {}), ...(str(i, "summary") ? { summary: str(i, "summary") } : {}) }) : null;
      return { reasonable_basis: ok, kind, recorded: recorded !== null, case_status: recorded?.status ?? null, basis_summary: recorded?.basis_summary ?? null }; }),
    guardrails: [never("NO_NOTICE_WITHOUT_BASIS", "9.2 guardrail: no notice without a recorded basis", (i) => flag(i, "send_notice") && !i.basis_evidence_id, "record the reasonable-basis evidence first"),
      never("BASIS_NEEDS_EVIDENCE", "9.2 rule 1 / decision record: basis evidence hashes", (i) => flag(i, "record") && !i.basis_evidence_id, "a recorded basis cites its evidence document (basis_evidence_id)")] },
  { name: "checkEscrowGuard", kind: "read", handler: compute((i, _ctx, rt) => { const facts = { escrowed: flag(i, "escrowed"), regx_days_delinquent: num(i, "regx_days_delinquent") || 0, cancellation_reason: reason(i), vacant: flag(i, "vacant") };
      const gate = evaluateGate("9.2.escrowedAdvanceBeforeForcePlacement", facts);
      const c = str(i, "case_id") ? fpiService(rt)?.get(str(i, "case_id")) : undefined;
      return { guard: escrowGuard(facts.escrowed, facts.regx_days_delinquent, facts.cancellation_reason, facts.vacant), k5_gate_open: gate.open, reason: gate.reason ?? null, timer: "REGX_1024_17K5_LPI_PURCHASE_GATE", case_k5_gate: c?.k5_gate ?? null, case_status: c?.status ?? null }; }) },
]);
