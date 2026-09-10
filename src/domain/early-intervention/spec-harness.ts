/**
 * §11 spec-test harness: a loan-scoped TimerEngine on the registry with the early-intervention overrides applied and
 * the section's "cancelled by" reader attached — what the unit of work builds for a loan — so the T-tests drive the
 * real timers with the events the §11 producers emit. Event types are passed in by the tests (no literals here).
 */
import { MemoryEventStore, FixedClock, SYSTEM, type DomainEvent } from "../../kernel/events/index.ts";
import { TimerEngine, loadRegistry, type TimerInstance, type TimerRegistry } from "../../kernel/timers/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { applyEarlyInterventionTimerOverrides, attachEarlyInterventionTimerCancellations, attachEarlyInterventionRecurringGuard } from "./timers.ts";
import { applySatisfiedOverrides_11_5 } from "./timers-11-5.ts";
import { applySatisfiedOverrides_11_1 } from "./timers-11-1.ts";
import { attachBankruptcyResumeHooks_11_1 } from "./ops-11-1.ts";

export const SECTION_11_PROCESSES = ["11.1", "11.2", "11.3", "11.4", "11.5"] as const;
/** An ISO instant at `hhmm` Eastern on `date` (the registry's deadlines are 23:59 ET; the 00:05 jobs run the next morning). */
export const atEt = (date: string, hhmm: string): string => toIso(zonedEpochMs(D(date), hhmm, "America/New_York"));
/** Noon Eastern on `date` — an event whose anchor date is `date` in the engine's civil-date resolution. */
export const noonEt = (date: string): string => atEt(date, "12:00");

export interface EiEngine {
  readonly loanId: string;
  readonly events: MemoryEventStore;
  readonly engine: TimerEngine;
  readonly registry: TimerRegistry;
  emit(type: string, payload: Record<string, unknown>, occurredAt: string, loanId?: string | null): DomainEvent;
  byCode(code: string): readonly TimerInstance[];
  armed(code: string): readonly TimerInstance[];
  breachCodes(nowIso: string): string[];
}
export function eiEngine(o: { loanId?: string; now?: string; processes?: readonly string[] } = {}): EiEngine {
  const loanId = o.loanId ?? "L-11";
  const clock = new FixedClock(o.now ?? "2026-11-02T05:05:00.000Z");
  const events = new MemoryEventStore(clock);
  const registry = loadRegistry(); applyEarlyInterventionTimerOverrides(registry);
  applySatisfiedOverrides_11_1(registry); applySatisfiedOverrides_11_5(registry);   // the 11.1 / 11.5 process overrides run after the section's and win, as in src/domain/timer-overrides.ts
  let engine!: TimerEngine;
  attachEarlyInterventionRecurringGuard(events, () => engine);   // before the engine subscribes (see timers.ts)
  engine = new TimerEngine(registry, events, { processes: [...(o.processes ?? SECTION_11_PROCESSES)] });
  attachEarlyInterventionTimerCancellations(engine, events);
  attachBankruptcyResumeHooks_11_1({ events });   // 11.1 ingestion: 14.3's resume decision re-opens the §1024.39(a) windows (ops-11-1.ts)
  return {
    loanId, events, engine, registry,
    emit: (type, payload, occurredAt, l = loanId) => events.append({ type, ...(l ? { loanId: l } : {}), actor: SYSTEM, payload, occurredAt }),
    byCode: (code) => engine.byCode(code).filter((i) => i.loanId === loanId),
    armed: (code) => engine.byCode(code).filter((i) => i.loanId === loanId && i.status === "armed"),
    breachCodes: (nowIso) => engine.evaluate(nowIso).map((b) => b.instance.code),
  };
}
