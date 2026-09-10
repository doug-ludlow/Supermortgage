/** Prints the (process, tool) pairs registered on the bus, for tools/audit.py. */
import { ALL_TOOLS } from "../src/app/tools/index.ts";
process.stdout.write(JSON.stringify(ALL_TOOLS.map((t) => ({ process: t.process, name: t.name, kind: t.kind }))) + "\n");
