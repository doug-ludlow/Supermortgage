/** 18.1 QC-as-code — sampling, error rates, tolerances, seeded draws. */

/** Finite-population sample at 95% / ±5% / p = 0.5: n0 = 384.16; n = ceil(n0 / (1 + (n0 − 1)/N)), floor 30, ceiling N. */
export function sampleSize(N: number): number {
  if (N <= 0) return 0;
  const n0 = (1.96 * 1.96 * 0.25) / (0.05 * 0.05);
  const n = Math.ceil(n0 / (1 + (n0 - 1) / N));
  return Math.min(N, Math.max(30, n));
}

/** Deterministic PRNG (mulberry32) so an examiner can regenerate a draw from the recorded seed. */
export function seededDraw<T>(items: readonly T[], n: number, seed: number): T[] {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
  return pool.slice(0, Math.min(n, pool.length));
}

export interface TargetedFlags { readonly denial?: boolean; readonly appeal?: boolean; readonly foreclosure_referral?: boolean; readonly scra?: boolean; readonly fraud?: boolean; readonly regulator_complaint?: boolean; readonly confidence?: number; readonly overridden?: boolean; readonly prior_finding_cycles_remaining?: number; }
/** Rule B — always-in additions on top of the random draw. */
export function targeted(f: TargetedFlags): boolean {
  return !!(f.denial || f.appeal || f.foreclosure_referral || f.scra || f.fraud || f.regulator_complaint || f.overridden || (f.confidence !== undefined && f.confidence < 0.8) || (f.prior_finding_cycles_remaining ?? 0) > 0);
}

export interface ErrorRate { readonly rate: number; readonly wilson_low: number; readonly wilson_high: number; readonly n: number; }
export function errorRate(fails: number, passes: number): ErrorRate {
  const n = fails + passes;
  if (n === 0) return { rate: 0, wilson_low: 0, wilson_high: 0, n: 0 };
  const p = fails / n, z = 1.96, z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { rate: p, wilson_low: Math.max(0, centre - half), wilson_high: Math.min(1, centre + half), n };
}

export type RuleFamily = "rederive" | "judgment" | "sev1_consumer_harm";
export const TOLERANCE: Readonly<Record<RuleFamily, number>> = { rederive: 0.02, judgment: 0.05, sev1_consumer_harm: 0 };
export function toleranceBreached(fails: number, passes: number, family: RuleFamily): boolean { return errorRate(fails, passes).rate > TOLERANCE[family]; }
