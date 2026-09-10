/** Ad-hoc: arm a timer from an event and print the instance. node --experimental-strip-types tools/timer-probe.ts CODE PROCESS EVENT_TYPE '{payload json}' */
import { MemoryEventStore, FixedClock, SYSTEM } from "../src/kernel/events/index.ts";
import { TimerEngine } from "../src/kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../src/domain/timer-overrides.ts";
const [code, proc, type, payload] = process.argv.slice(2);
const clock = new FixedClock("2026-09-01T14:00:00.000Z"); const events = new MemoryEventStore(clock);
const reg = loadOverriddenRegistry(); const timers = new TimerEngine(reg, events, { processes: [proc!] });
console.log(JSON.stringify(reg.get(code!)));
events.append({ type: type!, loanId: "L-1", actor: SYSTEM, payload: JSON.parse(payload ?? "{}") });
console.log(JSON.stringify(timers.byCode(code!)));
console.log(timers.evaluate("2026-10-02T04:30:00.000Z").map((b) => b.def.code));
