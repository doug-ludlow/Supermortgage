/**
 * Agent registry — the 20 agents the spec defines (spec/registry/agents.json,
 * extracted by tools/extract_agents.py): the processes each owns, its tool
 * allowlist, and the human roles it escalates to. The registry also carries
 * the AI-path state per agent: the 18.1 kill switch (two consecutive days of
 * override rate outside [2%, 15%] on a T1 system) and the operator's AI-off
 * flag, both of which route every command of that agent to the human path
 * with identical rule codes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { killSwitch } from "../domain/qc-audit/findings.ts";

export interface AgentDef { readonly agent: string; readonly processes: readonly string[]; readonly tools: readonly string[]; readonly escalates_to: readonly string[]; }
export interface ProcessAgentRow { readonly process: string; readonly agent: string | null; readonly agents_named: readonly string[]; readonly tools: readonly string[]; readonly guardrails: string; readonly escalates_to: readonly string[]; }
interface AgentsFile { readonly agents: readonly AgentDef[]; readonly processes: readonly ProcessAgentRow[]; }

export function loadAgentsFile(): AgentsFile {
  return JSON.parse(readFileSync(fileURLToPath(new URL("../../spec/registry/agents.json", import.meta.url)), "utf8")) as AgentsFile;
}

/** Owners the extractor could not resolve from the paragraph, per the section READMEs. */
const OWNER_FALLBACK: Record<string, string> = { "12.7": "lossmit-underwriter" };

export interface AiState { readonly off: boolean; readonly why?: string; readonly tier: "T0_deterministic" | "T1_consequential" | "T2_borrower_facing" | "T3_internal"; }

export class AgentRegistry {
  private readonly defs = new Map<string, AgentDef>();
  private readonly byProcess = new Map<string, string>();
  private readonly extraTools = new Map<string, Set<string>>();
  private readonly off = new Map<string, string>();
  private readonly tiers = new Map<string, AiState["tier"]>();
  private readonly overrideRates = new Map<string, number[]>();

  constructor(file: AgentsFile = loadAgentsFile()) {
    for (const a of file.agents) this.defs.set(a.agent, a);
    for (const p of file.processes) { const owner = p.agent ?? OWNER_FALLBACK[p.process]; if (owner) this.byProcess.set(p.process, owner); }
    for (const [proc, owner] of Object.entries(OWNER_FALLBACK)) if (!this.byProcess.has(proc)) this.byProcess.set(proc, owner);
    for (const a of this.defs.keys()) this.tiers.set(a, "T1_consequential");
  }
  agents(): readonly AgentDef[] { return [...this.defs.values()]; }
  get(agent: string): AgentDef { const d = this.defs.get(agent); if (!d) throw new RangeError(`unknown agent ${agent}`); return d; }
  ownerOf(process: string): string | undefined { return this.byProcess.get(process); }

  /**
   * Commands are named `<process-owner tool surface>.<tool>`; an agent may
   * call a command when the tool is in its allowlist (spec paragraph) or the
   * command belongs to a process it owns and was registered for it.
   */
  registerTool(agent: string, commandName: string): void { let s = this.extraTools.get(agent); if (!s) { s = new Set(); this.extraTools.set(agent, s); } s.add(commandName); }
  allows(agent: string, commandName: string): boolean {
    const d = this.defs.get(agent); if (!d) return false;
    const tool = commandName.includes(".") ? commandName.slice(commandName.lastIndexOf(".") + 1) : commandName;
    return d.tools.includes(tool) || (this.extraTools.get(agent)?.has(commandName) ?? false);
  }

  setTier(agent: string, tier: AiState["tier"]): void { this.tiers.set(agent, tier); }
  /** Operator AI-off (the "human path" — same queue, same rule codes). */
  setAiOff(agent: string, why: string | null): void { if (why === null) this.off.delete(agent); else this.off.set(agent, why); }
  /** 18.1 monitoring feed: daily override rate; two consecutive out-of-band days trip the kill switch on T1 agents. */
  recordOverrideRate(agent: string, day: string, rate: number): { tripped: boolean } {
    let arr = this.overrideRates.get(agent); if (!arr) { arr = []; this.overrideRates.set(agent, arr); }
    arr.push(rate);
    const tier = this.tiers.get(agent) ?? "T1_consequential";
    const tripped = killSwitch(arr, tier === "T1_consequential" ? "T1" : "T2");
    if (tripped) this.off.set(agent, `kill switch: override rate ${arr.slice(-2).map((r) => (100 * r).toFixed(1) + "%").join(", ")} on ${day} (18.1)`);
    return { tripped };
  }
  aiState(agent: string): AiState {
    const why = this.off.get(agent);
    return { off: why !== undefined, ...(why !== undefined ? { why } : {}), tier: this.tiers.get(agent) ?? "T1_consequential" };
  }
}
