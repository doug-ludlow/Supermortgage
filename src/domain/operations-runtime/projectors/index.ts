/**
 * §35.1 — the authored projector map registry: one exported map per typed kind (rule 1), keyed by kind; the phase order
 * (row projectors in `before`, fact projectors in `commit` — rule 2) and the topological order a command runs them in
 * (`after: [kind]`; a cycle is refused at startup, not at runtime — edge case 2). `HISTORY_KINDS` is rule 6's declared set:
 * `payments`, `counterparty_notifications` and every kind whose map says `history: true`.
 *
 * A kind with no map stays JSONB and is a listed gap (`projection_gaps{reason: no_projector}`), never an invisible one.
 */
import type { ProjectorMap } from "./types.ts";
import { SECTION_02_PROJECTORS } from "./section02.ts";
import { SECTION_16_PROJECTORS } from "./section16.ts";
import { SECTION_21_PROJECTORS } from "./section21.ts";

const ALL: readonly ProjectorMap[] = [...SECTION_02_PROJECTORS, ...SECTION_16_PROJECTORS, ...SECTION_21_PROJECTORS];

/** Topological order over `after`, stable in authoring order; throws on a cycle (edge case 2: "refuses a cycle at startup, not at runtime"). */
function order(maps: readonly ProjectorMap[]): ProjectorMap[] {
  const byKind = new Map(maps.map((m) => [m.kind, m] as const));
  const out: ProjectorMap[] = []; const state = new Map<string, "visiting" | "done">();
  const visit = (m: ProjectorMap, path: string[]): void => {
    const s = state.get(m.kind);
    if (s === "done") return;
    if (s === "visiting") throw new RangeError(`projector cycle: ${[...path, m.kind].join(" → ")} (35.1 edge case: a cycle is refused at startup)`);
    state.set(m.kind, "visiting");
    for (const dep of m.after ?? []) { const d = byKind.get(dep); if (!d) throw new RangeError(`projector ${m.kind} names after: ${dep}, which has no map`); visit(d, [...path, m.kind]); }
    state.set(m.kind, "done"); out.push(m);
  };
  for (const m of maps) visit(m, []);
  return out;
}

const ORDERED = order(ALL);
for (const m of ORDERED) if (ALL.filter((x) => x.kind === m.kind).length > 1) throw new RangeError(`two projector maps for kind ${m.kind}`);

/** Every authored map, in the order a command runs them. */
export const PROJECTORS: readonly ProjectorMap[] = ORDERED;
export const PROJECTOR_BY_KIND: ReadonlyMap<string, ProjectorMap> = new Map(ORDERED.map((m) => [m.kind, m]));
export const projectorFor = (kind: string): ProjectorMap | undefined => PROJECTOR_BY_KIND.get(kind);

/** Rule 6: the kinds hydration loads in full — `payments`, `counterparty_notifications`, and any kind whose map says `history: true`. */
export const HISTORY_KINDS: ReadonlySet<string> = new Set(["payments", "counterparty_notifications", ...ORDERED.filter((m) => m.history).map((m) => m.kind)]);

/** The typed kinds by phase. */
export const projectorsInPhase = (phase: "before" | "commit"): readonly ProjectorMap[] => ORDERED.filter((m) => m.phase === phase);
