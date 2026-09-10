/** Ad-hoc: node --experimental-strip-types tools/pattern-check.ts 'pattern' … — prints how the event grammar parses each argument. */
import { parseEventPattern } from "../src/kernel/events/match.ts";
for (const s of process.argv.slice(2)) console.log(s, "→", JSON.stringify(parseEventPattern(s)));
