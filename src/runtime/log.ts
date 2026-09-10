/** Structured logging to stdout: one JSON object per line (Cloud Logging parses `severity` and `message`), or text locally. */
export type Level = "DEBUG" | "INFO" | "WARNING" | "ERROR";
export interface Logger { log(level: Level, message: string, fields?: Record<string, unknown>): void; info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void; error(message: string, fields?: Record<string, unknown>): void; }

const plain = (v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v);

export function createLogger(format: "json" | "text", out: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const log = (level: Level, message: string, fields: Record<string, unknown> = {}): void => {
    const ts = new Date().toISOString();
    if (format === "json") out(JSON.stringify({ severity: level, message, time: ts, ...fields }, (_k, v) => plain(v)));
    else out(`${ts} ${level.padEnd(7)} ${message}${Object.keys(fields).length ? " " + JSON.stringify(fields, (_k, v) => plain(v)) : ""}`);
  };
  return { log, info: (m, f) => log("INFO", m, f), warn: (m, f) => log("WARNING", m, f), error: (m, f) => log("ERROR", m, f) };
}
