/**
 * §35.7 — the roles a bus tool admits on the human path, shared by the console's tools route and /v1's principal layer
 * (34.1 rule 3; src/console/server.ts toolRoles): the tool's own humanRoles, else ops_analyst + officer + the process's
 * escalation roles from spec/registry/agents.json; a tool that declares moneyFields is officer's on either surface (34.1 rule 2).
 */
import { loadAgentsFile } from "../../../app/agents.ts";
import type { ToolDef } from "../../../app/tools.ts";

let escalatesTo: Map<string, readonly string[]> | null = null;
export function toolRoles(def: Pick<ToolDef, "humanRoles" | "process">): readonly string[] {
  if (def.humanRoles) return def.humanRoles;
  escalatesTo ??= new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  return [...new Set(["ops_analyst", "officer", ...(escalatesTo.get(def.process) ?? [])])];
}
export const acceptedRoles = (def: Pick<ToolDef, "humanRoles" | "process" | "moneyFields">): readonly string[] => (def.moneyFields?.length ? ["officer"] : toolRoles(def));
