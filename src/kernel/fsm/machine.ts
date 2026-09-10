/**
 * Declarative state machines. Every process spec has a "State machine"
 * subsection of the form
 *   `staged` —(all mapping rules applied, `boarding.stage.validate`)→ `validated`
 * with guards ("if zero open hard failures") and actor requirements
 * ("`waived_with_reason` on a hard rule requires `officer` approval").
 *
 * `Machine` encodes those rules and refuses anything else. Transitions are
 * pure decisions; the caller records the resulting event.
 */
import type { Actor } from "../events/types.ts";

export interface TransitionContext<S extends string, Ctx> {
  readonly from: S;
  readonly to: S;
  readonly actor: Actor;
  readonly ctx: Ctx;
}

export interface Transition<S extends string, Ctx> {
  readonly from: S | readonly S[];
  readonly to: S;
  /** The command/trigger name, e.g. `boarding.stage.validate`. */
  readonly on: string;
  /** Returns a reason string when the transition is NOT allowed, undefined when it is. */
  readonly guard?: (t: TransitionContext<S, Ctx>) => string | undefined;
  /** Roles allowed to drive this transition; omitted = any actor. */
  readonly roles?: readonly string[];
}

export interface MachineDef<S extends string, Ctx> {
  readonly name: string;
  readonly initial: S;
  readonly states: readonly S[];
  readonly terminal: readonly S[];
  readonly transitions: readonly Transition<S, Ctx>[];
}

export type TransitionResult<S extends string> =
  | { ok: true; from: S; to: S; on: string }
  | { ok: false; from: S; on: string; reason: string; code: "NO_TRANSITION" | "GUARD_FAILED" | "ROLE_DENIED" | "TERMINAL" };

export class Machine<S extends string, Ctx = unknown> {
  readonly def: MachineDef<S, Ctx>;
  constructor(def: MachineDef<S, Ctx>) {
    this.def = def;
    for (const t of def.transitions) {
      const froms = Array.isArray(t.from) ? t.from : [t.from];
      for (const f of froms as S[]) if (!def.states.includes(f)) throw new Error(`${def.name}: unknown state ${f}`);
      if (!def.states.includes(t.to)) throw new Error(`${def.name}: unknown state ${t.to}`);
    }
  }

  isTerminal(s: S): boolean { return this.def.terminal.includes(s); }

  /** All transitions legal from `s` for the given command, ignoring guards. */
  candidates(s: S, on: string): readonly Transition<S, Ctx>[] {
    return this.def.transitions.filter((t) => t.on === on && (Array.isArray(t.from) ? (t.from as readonly S[]).includes(s) : t.from === s));
  }

  attempt(from: S, on: string, actor: Actor, ctx: Ctx): TransitionResult<S> {
    if (this.isTerminal(from)) return { ok: false, from, on, reason: `${from} is terminal`, code: "TERMINAL" };
    const cands = this.candidates(from, on);
    if (cands.length === 0) return { ok: false, from, on, reason: `no transition from ${from} on ${on}`, code: "NO_TRANSITION" };
    let lastReason = "";
    for (const t of cands) {
      if (t.roles && !t.roles.includes(actor.role ?? actor.id)) {
        lastReason = `requires role ${t.roles.join("|")}, actor ${actor.kind}:${actor.id}${actor.role ? `(${actor.role})` : ""}`;
        continue;
      }
      const reason = t.guard?.({ from, to: t.to, actor, ctx });
      if (reason === undefined) return { ok: true, from, to: t.to, on };
      lastReason = reason;
    }
    const denied = cands.every((t) => t.roles && !t.roles.includes(actor.role ?? actor.id));
    return { ok: false, from, on, reason: lastReason, code: denied ? "ROLE_DENIED" : "GUARD_FAILED" };
  }
}
