/**
 * Helpers and types shared by every evaluator map: the section files under
 * src/domain/<section>/evaluators.ts build their gate predicates from these so
 * they never import the aggregate map (no cycle).
 */
import { daysBetween, addDays, addYears, type PlainDate } from "../kernel/calendar/date.ts";
export { daysBetween, addDays, addYears, type PlainDate };

export interface GateResult { readonly open: boolean; readonly reason?: string; }
export type Facts = Record<string, unknown>;
export type Evaluator = (f: Facts) => GateResult;

export const ok: GateResult = { open: true };
export const no = (reason: string): GateResult => ({ open: false, reason });
export const b = (f: Facts, k: string): boolean => f[k] === true;
export const n = (f: Facts, k: string): number => Number(f[k] ?? NaN);
export const c = (f: Facts, k: string): bigint => (typeof f[k] === "bigint" ? (f[k] as bigint) : BigInt(String(f[k] ?? "0")));
export const s = (f: Facts, k: string): string => String(f[k] ?? "");
export const arr = <T>(f: Facts, k: string): T[] => (Array.isArray(f[k]) ? (f[k] as T[]) : []);
export const every = (f: Facts, keys: readonly string[], what: string): GateResult => { const missing = keys.filter((k) => !b(f, k)); return missing.length ? no(`${what}: ${missing.join(", ")} not satisfied`) : ok; };
export const atMost = (v: number, max: number, what: string): GateResult => (v <= max ? ok : no(`${what}: ${v} > ${max}`));
export const atLeast = (v: number, min: number, what: string): GateResult => (v >= min ? ok : no(`${what}: ${v} < ${min}`));
/** Trailing-window counter: timestamps (ISO) within `days` before `now`. */
export const within = (f: Facts, k: string, days: number, now: string): number => arr<string>(f, k).filter((t) => Date.parse(now) - Date.parse(t) < days * 86_400_000 && Date.parse(t) <= Date.parse(now)).length;

