/**
 * Loan-level boarding state machine (spec 1.1 "State machine"):
 *
 *   staged ──validate──▶ validated  (zero open hard failures)
 *   staged ──validate──▶ exception  (otherwise)
 *   exception ──revalidate──▶ validated | exception
 *   exception ──reject──▶ rejected_to_transferor   (transfer agent files Form 629 amendment, 1.2)
 *   validated ──board──▶ boarded  (transfer date reached; final tape reconciled at batch level)
 *   boarded ──reconcile──▶ reconciled ──activate──▶ active
 *   any ──withdraw──▶ withdrawn (paid off / foreclosed / repurchased between tapes)
 *
 * Waivers are not a state transition: they change a validation's result and
 * then `revalidate` runs. The role requirement for waivers lives in the service.
 */
import { Machine } from "../../kernel/fsm/machine.ts";

export type BoardingStatus = "staged" | "validated" | "exception" | "boarded" | "reconciled" | "active" | "rejected_to_transferor" | "withdrawn";

export interface BoardingCtx {
  readonly openHardFailures: number;
  readonly transferDateReached: boolean;
  readonly finalTapeReconciled: boolean;
  readonly onApprovedList: boolean;
}

export const boardingMachine = new Machine<BoardingStatus, BoardingCtx>({
  name: "boarding",
  initial: "staged",
  states: ["staged", "validated", "exception", "boarded", "reconciled", "active", "rejected_to_transferor", "withdrawn"],
  terminal: ["active", "rejected_to_transferor", "withdrawn"],
  transitions: [
    { from: ["staged", "exception", "validated"], to: "validated", on: "validate", guard: (t) => (t.ctx.openHardFailures === 0 ? undefined : `${t.ctx.openHardFailures} open hard failures`) },
    { from: ["staged", "exception", "validated"], to: "exception", on: "validate", guard: (t) => (t.ctx.openHardFailures > 0 ? undefined : "no open hard failures") },
    { from: "exception", to: "rejected_to_transferor", on: "reject", roles: ["transfer", "officer"] },
    { from: "validated", to: "boarded", on: "board", guard: (t) => t.ctx.openHardFailures > 0 ? "cannot board with an open hard failure" : !t.ctx.transferDateReached ? "transfer date not reached" : !t.ctx.finalTapeReconciled ? "final tape not reconciled at batch level" : undefined },
    { from: "boarded", to: "reconciled", on: "reconcile" },
    { from: "reconciled", to: "active", on: "activate" },
    { from: ["staged", "validated", "exception", "boarded", "reconciled"], to: "withdrawn", on: "withdraw" },
  ],
});
