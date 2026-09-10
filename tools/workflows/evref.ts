import { loadOverriddenRegistry } from "/home/user/Supermortgage/src/domain/timer-overrides.ts";
import { EVALUATORS } from "/home/user/Supermortgage/src/app/evaluators.ts";
const refs = loadOverriddenRegistry().unique().filter((t) => t.offsetParsed.kind === "evaluator").map((t) => (t.offsetParsed as { ref: string }).ref);
console.log("unreferenced:", Object.keys(EVALUATORS).filter((k) => !refs.includes(k)));
console.log("missing:", refs.filter((r) => !EVALUATORS[r]));
