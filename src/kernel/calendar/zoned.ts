/**
 * Wall-clock instants: "03:00 America/New_York on 2026-12-03" → epoch ms.
 * Uses Intl to resolve the zone offset for that specific wall time (handles
 * DST correctly, including the ET cut-offs Fannie Mae publishes).
 */
import { type PlainDate, parts, plainDate } from "./date.ts";

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock components of an instant in `timeZone`. */
export function wallClock(epochMs: number, timeZone: string): { date: PlainDate; hour: number; minute: number; second: number } {
  const p: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(epochMs))) if (part.type !== "literal") p[part.type] = part.value;
  return {
    date: plainDate(`${p.year}-${p.month}-${p.day}`),
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second),
  };
}

/** Epoch ms for `date` at `HH:MM` wall time in `timeZone`. Ambiguous/skipped DST times resolve to the earlier offset. */
export function zonedEpochMs(date: PlainDate, hhmm: string, timeZone: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new TypeError(`bad time ${hhmm}`);
  const hour = Number(m[1]), minute = Number(m[2]);
  const { y, mo, d } = (() => { const q = parts(date); return { y: q.y, mo: q.m, d: q.d }; })();
  // First guess: treat wall time as UTC, then correct by the zone's offset at that instant (iterate twice for DST edges).
  let guess = Date.UTC(y, mo - 1, d, hour, minute, 0, 0);
  for (let i = 0; i < 2; i++) {
    const w = wallClock(guess, timeZone);
    const wallAsUtc = Date.UTC(Number(w.date.slice(0, 4)), Number(w.date.slice(5, 7)) - 1, Number(w.date.slice(8, 10)), w.hour, w.minute, w.second);
    const diff = wallAsUtc - guess; // offset of the zone at `guess`
    guess = Date.UTC(y, mo - 1, d, hour, minute, 0, 0) - diff;
  }
  return guess;
}

export function toIso(epochMs: number): string { return new Date(epochMs).toISOString(); }
