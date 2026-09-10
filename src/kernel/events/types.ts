/**
 * `loan_events` is the append-only spine of the platform. Every process emits
 * dotted event types (`loan.boarded`, `payment.posted`, `transfer.tape.received`)
 * and every timer in the registry is armed by one and satisfied by another.
 */
export type EventType = string;

export type ActorKind = "agent" | "human" | "system" | "external";

export interface Actor {
  readonly kind: ActorKind;
  /** e.g. agent name `boarding`, human role `officer`, external `fnma`, `mers`. */
  readonly id: string;
  readonly role?: string;
}

export interface DomainEvent<P = Record<string, unknown>> {
  readonly id: string;
  readonly type: EventType;
  readonly occurredAt: string;              // ISO instant
  readonly loanId?: string;
  readonly aggregate?: { readonly kind: string; readonly id: string }; // batch, case, payment...
  readonly actor: Actor;
  readonly payload: P;
  readonly causationId?: string;             // the command/event that produced this one
  readonly correlationId?: string;           // the business flow this belongs to
  readonly sequence: number;                 // monotonic per store
}

export interface EventInput<P = Record<string, unknown>> {
  readonly type: EventType;
  readonly loanId?: string;
  readonly aggregate?: { readonly kind: string; readonly id: string };
  readonly actor: Actor;
  readonly payload?: P;
  readonly occurredAt?: string;
  readonly causationId?: string;
  readonly correlationId?: string;
}

export const SYSTEM: Actor = { kind: "system", id: "platform" };
