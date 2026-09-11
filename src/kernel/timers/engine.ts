/**
 * Timer engine. A `TimerInstance` is one armed row of the registry for one
 * subject (a loan, a batch, a case). Lifecycle:
 *
 *   armed ──satisfied event──▶ satisfied
 *     │──deadline passes──▶ breached ──(later satisfied)──▶ satisfied_late
 *     └──cancel──▶ cancelled
 *
 * The engine is deterministic: `evaluate(now)` breaches whatever is overdue and
 * returns the breach records (severity + escalation roles from the registry's
 * `breach` column). Recurring timers re-arm themselves on satisfaction.
 */
import { randomUUID } from "node:crypto";
import type { DomainEvent, EventStore, Actor } from "../events/index.ts";
import { eventMatches, SYSTEM } from "../events/index.ts";
import { type PlainDate, addDays, addMonths, addYears, plainDate, parts, ymd, endOfMonth } from "../calendar/date.ts";
import { addBusinessDays, rollForward, rollBack, nextBusinessDay, type CalendarSet, defaultCalendars, type DayUnit } from "../calendar/business.ts";
import { zonedEpochMs, wallClock } from "../calendar/zoned.ts";
import type { TimerDef, TimerRegistry } from "./registry.ts";
import type { ParsedOffset } from "./offset.ts";

export type TimerStatus = "armed" | "satisfied" | "breached" | "satisfied_late" | "cancelled" | "needs_human";

export interface TimerInstance {
  readonly applicationId?: string;
  readonly id: string;
  readonly code: string;
  readonly subject: { readonly kind: string; readonly id: string };
  readonly loanId?: string;
  readonly armedAt: string;
  readonly armedByEventId: string;
  readonly anchorDate: PlainDate;
  /** Epoch ms at which the timer is due (undefined for gates/prose). */
  readonly dueAt?: number;
  readonly dueDate?: PlainDate;
  status: TimerStatus;
  satisfiedAt?: string;
  satisfiedByEventId?: string;
  breachedAt?: string;
  cancelledReason?: string;
  readonly note?: string;
}

export interface Breach {
  readonly instance: TimerInstance;
  readonly def: TimerDef;
  readonly severity: 1 | 2 | 3 | 4 | null;
  readonly escalateTo: readonly string[];
  readonly breachText: string;
}

export interface AnchorResolver {
  /** Resolve the anchor for a timer from the triggering event; return undefined if unknown. */
  (def: TimerDef, event: DomainEvent): PlainDate | undefined;
}

/** Default anchor resolution: `payload[anchorField]` as an ISO date, else the event's own date. */
export const defaultAnchorResolver: AnchorResolver = (def, event) => {
  const fromPayload = def.anchorField ? (event.payload as Record<string, unknown>)[def.anchorField] : undefined;
  if (typeof fromPayload === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fromPayload)) return plainDate(fromPayload);
  // Timestamps anchor on their Eastern-time civil date (Fannie Mae and Reg X cut-offs are ET / servicer-local).
  if (typeof fromPayload === "string" && /^\d{4}-\d{2}-\d{2}T/.test(fromPayload)) return wallClock(Date.parse(fromPayload), "America/New_York").date;
  return wallClock(Date.parse(event.occurredAt), "America/New_York").date;
};

export interface DueComputation { dueDate?: PlainDate; dueAt?: number; needsHuman?: string; opensDate?: PlainDate; evaluator?: string; }

type StepLike = Extract<ParsedOffset, { kind: "step" }>;
export function computeDue(offset: ParsedOffset, anchor: PlainDate, anchorMs: number, cals: CalendarSet = defaultCalendars): DueComputation {
  const endOfDay = (d: PlainDate, tz = "America/New_York") => zonedEpochMs(d, "23:59", tz);
  const atOrEod = (d: PlainDate, at?: { hhmm: string; timeZone: string }) =>
    at && !at.timeZone.endsWith("_local") ? zonedEpochMs(d, at.hhmm, at.timeZone) : endOfDay(d);   // servicer_local / loan_local resolve per subject; end of day (ET) until then
  switch (offset.kind) {
    case "none": return {};
    case "same_day": return { dueDate: anchor, dueAt: endOfDay(anchor) };
    case "next_business_day": {
      const d = nextBusinessDay(anchor, cals[offset.unit]);
      return { dueDate: d, dueAt: atOrEod(d, offset.at) };
    }
    case "step":
    case "recurring": {
      const n = offset.kind === "step" ? offset.n : offset.every;
      const unit = offset.unit;
      if (unit === "hours" || unit === "minutes") {
        const ms = anchorMs + n * (unit === "hours" ? 3_600_000 : 60_000);
        const rollTo = offset.kind === "step" ? offset.rollTo : undefined;
        if (rollTo) { const d = rollForward(wallClock(ms, "America/New_York").date, cals[rollTo]); return { dueDate: d, dueAt: Math.max(ms, zonedEpochMs(d, "09:00", "America/New_York")) }; }
        return { dueDate: wallClock(ms, "America/New_York").date, dueAt: ms };
      }
      let d: PlainDate;
      if (unit === "months") d = addMonths(anchor, n);
      else if (unit === "years") d = addYears(anchor, n);
      else if (unit === "calendar_days") d = addDays(anchor, n);
      else d = addBusinessDays(anchor, n, cals[unit as DayUnit]);
      if (offset.kind === "step" && offset.rollTo) d = rollForward(d, cals[offset.rollTo]);
      return { dueDate: d, dueAt: atOrEod(d, offset.kind === "step" ? offset.at : undefined) };
    }
    case "until": return {};   // gate: armed with no due date, closes on its satisfying event
    case "evaluator": return { evaluator: offset.ref };   // gate/rule asserted by domain code
    case "window": {
      const step = (n: number, unit: ParsedOffset & { kind: "step" } extends never ? never : StepLike["unit"]) => computeDue({ kind: "step", n, unit }, anchor, anchorMs, cals).dueDate!;
      const opens = step(offset.open.n, offset.open.unit), closes = step(offset.close.n, offset.close.unit);
      return { opensDate: opens, dueDate: closes, dueAt: endOfDay(closes) };
    }
    case "calendar_day": {
      const a = parts(anchor);
      let y = a.y, mo = a.m;
      if (offset.month !== undefined) {
        // next occurrence of month/day on or after the anchor, plus any explicit year offset
        y = a.y + (offset.yearOffset ?? 0);
        mo = offset.month;
        const cand = ymd(y, mo, Math.min(offset.day, parts(endOfMonth(ymd(y, mo, 1))).d));
        if (cand < anchor && !offset.yearOffset) y += 1;
      } else {
        const shifted = addMonths(ymd(a.y, a.m, 1), offset.monthOffset);
        const sp = parts(shifted); y = sp.y; mo = sp.m;
      }
      const eom = endOfMonth(ymd(y, mo, 1));
      let d = offset.day === -1 ? eom : ymd(y, mo, Math.min(offset.day, parts(eom).d));
      if (offset.rollBackTo) d = rollBack(d, cals[offset.rollBackTo]);
      if (offset.rollTo) d = rollForward(d, cals[offset.rollTo]);
      return { dueDate: d, dueAt: atOrEod(d, offset.at) };
    }
    case "prose": return { needsHuman: `offset is prose: ${offset.text}` };
  }
}

export interface TimerEngineOptions {
  readonly calendars?: CalendarSet;
  readonly anchorResolver?: AnchorResolver;
  /** Only arm timers for these process ids (e.g. ["1.1"]) — useful while sections are being built out. */
  readonly processes?: readonly string[];
}

export class TimerEngine {
  private readonly instances: TimerInstance[] = [];
  private readonly cals: CalendarSet;
  private readonly resolveAnchor: AnchorResolver;
  private readonly processFilter: ReadonlySet<string> | null;
  private readonly registry: TimerRegistry;
  private readonly events: EventStore;

  constructor(registry: TimerRegistry, events: EventStore, opts: TimerEngineOptions = {}) {
    this.registry = registry;
    this.events = events;
    this.cals = opts.calendars ?? defaultCalendars;
    this.resolveAnchor = opts.anchorResolver ?? defaultAnchorResolver;
    this.processFilter = opts.processes ? new Set(opts.processes) : null;
    events.subscribe("*", (e) => this.onEvent(e));
  }

  all(): readonly TimerInstance[] { return this.instances; }
  /** Hydrate persisted instances (typically the open ones for a subject) so events can satisfy them. */
  restore(persisted: readonly TimerInstance[]): void { for (const i of persisted) if (!this.instances.some((x) => x.id === i.id)) this.instances.push(i); }
  open(): readonly TimerInstance[] { return this.instances.filter((i) => i.status === "armed" || i.status === "breached"); }
  forSubject(kind: string, id: string): readonly TimerInstance[] { return this.instances.filter((i) => i.subject.kind === kind && i.subject.id === id); }
  byCode(code: string): readonly TimerInstance[] { return this.instances.filter((i) => i.code === code); }

  private onEvent(e: DomainEvent): void {
    // 1. Satisfy anything waiting on this event (same subject). Iterate a snapshot: satisfying a
    //    recurring row re-arms it (arm() pushes onto this.instances) and the fresh instance must not
    //    be visited — and satisfied, and re-armed — by the same pass.
    for (const inst of [...this.instances]) {
      if (inst.status !== "armed" && inst.status !== "breached") continue;
      const def = this.registry.get(inst.code);
      if (!def?.satisfiedPattern || !eventMatches(def.satisfiedPattern, e)) continue;
      if (!sameSubject(inst, e)) continue;
      inst.satisfiedAt = e.occurredAt;
      inst.satisfiedByEventId = e.id;
      inst.status = inst.status === "breached" ? "satisfied_late" : "satisfied";
      this.events.append({ type: "timer.satisfied", ...(inst.loanId ? { loanId: inst.loanId } : {}), ...(inst.applicationId ? { applicationId: inst.applicationId } : {}), actor: SYSTEM, causationId: e.id,
        payload: { code: inst.code, timer_id: inst.id, late: inst.status === "satisfied_late" } });
      if (def.kindNorm === "recurring") this.arm(def, e, { subjectOverride: inst.subject });
    }
    // 2. Arm anything this event triggers.
    for (const def of this.registry.triggeredBy(e.type)) {
      if (this.processFilter && !this.processFilter.has(def.process)) continue;
      if (!def.triggerPattern || !eventMatches(def.triggerPattern, e)) continue;
      if (isOriginationDef(def) && !isOriginationContext(e)) continue;
      this.arm(def, e);
    }
  }

  arm(def: TimerDef, trigger: DomainEvent, opts: { subjectOverride?: TimerInstance["subject"] } = {}): TimerInstance {
    const subject = opts.subjectOverride ?? (trigger.loanId ? { kind: "loan", id: trigger.loanId } : trigger.applicationId ? { kind: "application", id: trigger.applicationId } : trigger.aggregate ?? { kind: "global", id: "*" });
    const anchor = this.resolveAnchor(def, trigger) ?? wallClock(Date.parse(trigger.occurredAt), "America/New_York").date;
    const anchorMs = Date.parse(trigger.occurredAt);
    const due = computeDue(def.offsetParsed, anchor, anchorMs, this.cals);
    const inst: TimerInstance = {
      id: randomUUID(), code: def.code, subject, ...(trigger.loanId ? { loanId: trigger.loanId } : {}), ...(trigger.applicationId ? { applicationId: trigger.applicationId } : {}),
      armedAt: trigger.occurredAt, armedByEventId: trigger.id, anchorDate: anchor,
      ...(due.dueAt !== undefined ? { dueAt: due.dueAt } : {}), ...(due.dueDate !== undefined ? { dueDate: due.dueDate } : {}),
      status: due.needsHuman ? "needs_human" : "armed",
      ...(due.needsHuman ? { note: due.needsHuman } : due.evaluator ? { note: `evaluator:${due.evaluator}` } : due.opensDate ? { note: `window opens ${due.opensDate}` } : {}),
    };
    this.instances.push(inst);
    this.events.append({ type: "timer.armed", ...(inst.loanId ? { loanId: inst.loanId } : {}), ...(inst.applicationId ? { applicationId: inst.applicationId } : {}), actor: SYSTEM, causationId: trigger.id,
      payload: { code: def.code, timer_id: inst.id, due_date: inst.dueDate ?? null, due_at: inst.dueAt !== undefined ? new Date(inst.dueAt).toISOString() : null, status: inst.status } });
    return inst;
  }

  /** Breach every armed timer whose dueAt has passed. Returns the new breaches. */
  evaluate(nowIso: string): Breach[] {
    const now = Date.parse(nowIso);
    const out: Breach[] = [];
    for (const inst of this.instances) {
      if (inst.status !== "armed" || inst.dueAt === undefined || inst.dueAt > now) continue;
      const def = this.registry.get(inst.code)!;
      inst.status = "breached";
      inst.breachedAt = nowIso;
      const b: Breach = { instance: inst, def, severity: def.severity.level, escalateTo: def.severity.escalateTo, breachText: def.breach };
      out.push(b);
      this.events.append({ type: "timer.breached", ...(inst.loanId ? { loanId: inst.loanId } : {}), ...(inst.applicationId ? { applicationId: inst.applicationId } : {}), actor: SYSTEM,
        payload: { code: inst.code, timer_id: inst.id, severity: b.severity, escalate_to: [...b.escalateTo], breach: def.breach } });
    }
    return out;
  }

  cancel(id: string, reason: string, actor: Actor = SYSTEM): void {
    const inst = this.instances.find((i) => i.id === id);
    if (!inst || (inst.status !== "armed" && inst.status !== "breached")) return;
    inst.status = "cancelled"; inst.cancelledReason = reason;
    this.events.append({ type: "timer.cancelled", ...(inst.loanId ? { loanId: inst.loanId } : {}), actor, payload: { code: inst.code, timer_id: inst.id, reason } });
  }
}

/** Sections 20–31 (origination) define timers that share servicing event names (`loan.boarded`, `loan.paid_in_full`, …):
 *  they arm only for an event that carries origination context — an application id, or a payload that names one — so a
 *  transferred-in loan on the servicing side never picks up an origination clock (one product, two contexts). */
export function isOriginationDef(def: { readonly process: string }): boolean { return Number(def.process.split(".")[0]) >= 20; }
export function isOriginationContext(e: DomainEvent): boolean {
  if (e.applicationId) return true;
  if (e.aggregate?.kind === "application") return true;
  const p = e.payload as Record<string, unknown>;
  return typeof p.application_id === "string" || p.source === "origination" || p.origination === true;
}
function sameSubject(inst: TimerInstance, e: DomainEvent): boolean {
  if (inst.subject.kind === "loan") return e.loanId === inst.subject.id;
  if (inst.subject.kind === "application") return e.applicationId === inst.subject.id || (e.payload as Record<string, unknown>).application_id === inst.subject.id;
  if (inst.subject.kind === "global") return true;
  return e.aggregate?.kind === inst.subject.kind && e.aggregate.id === inst.subject.id;
}
