/**
 * §35.6 State machine — the closing, funding, delivery and purchase steps (clear_to_close … purchased) and the off-path
 * `unwinding` step. Their actions are built in groups B and C; until a step's actions land it declares its exit so the fold
 * places a row correctly and waits idle on it.
 */
import type { DomainEvent } from "../../kernel/events/index.ts";
import type { OrchRecord } from "./facts-35-6.ts";
import type { StepDef } from "./steps-35-6.ts";

const exitOn = (type: string, pred?: (p: Record<string, unknown>) => boolean) => (rec: OrchRecord): DomainEvent | null => rec.last(type, pred);

export const closingSteps: readonly StepDef[] = [
  { name: "clear_to_close", exit: exitOn("closing.scheduled"), entryWait: () => ({ status: "waiting_borrower", waiting_on: "borrower", clocked: false }), clocked: () => false, idleWait: () => ({ status: "waiting_borrower", waiting_on: "borrower", clocked: false }) },
  { name: "closing_scheduled", exit: exitOn("disclosure.cd.waiting_period.computed", (p) => p["complete"] === true || p["earliest_consummation_date"] !== undefined), clocked: () => true },
  { name: "cd_delivered", exit: exitOn("closing.documents.released"), clocked: () => true },
  { name: "documents_released", exit: exitOn("closing.consummated"), clocked: () => true },
  { name: "consummated", exit: exitOn("closing.execution_review.passed"), clocked: () => true },
  { name: "execution_reviewed", exit: (rec) => (rec.has("funding.authorized") && rec.has("warehouse.advance.approved") ? rec.last("warehouse.advance.approved") : null), clocked: () => true },
];
export const fundingSteps: readonly StepDef[] = [
  { name: "funding_authorized", exit: exitOn("funding.wire.accepted"), clocked: () => true },
  { name: "wire_released", exit: exitOn("loan.funded"), clocked: () => true },
  { name: "funded", exit: exitOn("loan.boarded"), clocked: () => true },
];
export const deliverySteps: readonly StepDef[] = [
  { name: "boarded", exit: exitOn("delivery.package.frozen"), clocked: () => true },
  { name: "package_frozen", exit: exitOn("delivery.submitted"), clocked: () => true },
  { name: "delivered", exit: exitOn("custody.certified"), clocked: () => true },
  { name: "certified", exit: exitOn("loan.purchased"), clocked: () => true },
  { name: "purchased", exit: exitOn("orchestration.purchase.reconciled"), clocked: () => true },
];
export const unwindStep: StepDef = { name: "unwinding", exit: exitOn("funding.unwind.completed") };
