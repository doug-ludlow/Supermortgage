import { randomUUID } from "node:crypto";
import type { DomainEvent, EventInput } from "./types.ts";
import { eventMatches, parseEventPattern, type EventPattern } from "./match.ts";

export type Subscriber = (e: DomainEvent) => void | Promise<void>;

export interface Clock { now(): string; }
export const systemClock: Clock = { now: () => new Date().toISOString() };

/** A fixed clock for tests and replays. */
export class FixedClock implements Clock {
  private current: string;
  constructor(iso: string) { this.current = iso; }
  now(): string { return this.current; }
  set(iso: string): void { this.current = iso; }
}

export interface EventStore {
  append<P extends Record<string, unknown>>(input: EventInput<P>): DomainEvent<P>;
  byLoan(loanId: string): readonly DomainEvent[];
  ofType(type: string): readonly DomainEvent[];
  all(): readonly DomainEvent[];
  subscribe(pattern: string | EventPattern, fn: Subscriber): () => void;
}

/**
 * In-memory implementation. The Postgres one (`db/`) has the same interface;
 * domain logic never knows which it is talking to.
 */
export class MemoryEventStore implements EventStore {
  private readonly events: DomainEvent[] = [];
  private readonly subs: { pattern: EventPattern; fn: Subscriber }[] = [];
  private seq = 0;
  private readonly clock: Clock;
  constructor(clock: Clock = systemClock) { this.clock = clock; }

  append<P extends Record<string, unknown>>(input: EventInput<P>): DomainEvent<P> {
    const e: DomainEvent<P> = {
      id: randomUUID(),
      type: input.type,
      occurredAt: input.occurredAt ?? this.clock.now(),
      actor: input.actor,
      payload: (input.payload ?? {}) as P,
      sequence: ++this.seq,
      ...(input.loanId !== undefined ? { loanId: input.loanId } : {}),
      ...(input.aggregate !== undefined ? { aggregate: input.aggregate } : {}),
      ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    };
    this.events.push(e as DomainEvent);
    for (const s of this.subs) if (eventMatches(s.pattern, e as DomainEvent)) void s.fn(e as DomainEvent);
    return e;
  }
  byLoan(loanId: string): readonly DomainEvent[] { return this.events.filter((e) => e.loanId === loanId); }
  ofType(type: string): readonly DomainEvent[] { return this.events.filter((e) => e.type === type); }
  all(): readonly DomainEvent[] { return this.events; }
  subscribe(pattern: string | EventPattern, fn: Subscriber): () => void {
    const p = typeof pattern === "string" ? parseEventPattern(pattern) : pattern;
    if (!p) throw new TypeError(`bad event pattern: ${pattern}`);
    const entry = { pattern: p, fn };
    this.subs.push(entry);
    return () => { const i = this.subs.indexOf(entry); if (i >= 0) this.subs.splice(i, 1); };
  }
}
