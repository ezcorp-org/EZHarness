import type { AgentDefinition } from "../types";
import { loadYamlAgents } from "./yaml-loader";
import { logger } from "../logger";
const log = logger.child("loader");

export interface LoadAgentOptions {
  includeDb?: boolean;
}

// ── Dynamic loader (Bun / local) ───────────────────────────────────

export async function loadAgents(
  dir: string,
  opts?: LoadAgentOptions,
): Promise<Map<string, AgentDefinition>> {
  const agents = new Map<string, AgentDefinition>();

  // 1. TS agents
  const tsGlob = new Bun.Glob("*.agent.ts");
  for await (const file of tsGlob.scan({ cwd: dir, absolute: true })) {
    try {
      const mod = await import(file);
      const def = mod.default as unknown;

      if (!isValidAgent(def)) {
        log.warn("Skipping agent file: missing required name or execute", { file });
        continue;
      }

      agents.set(def.name, def);
    } catch (err) {
      log.warn("Failed to import agent file", { file, error: String(err) });
    }
  }

  // 2. YAML agents
  const yamlAgents = await loadYamlAgents(dir);
  for (const [name, def] of yamlAgents) {
    agents.set(name, def);
  }

  // 3. DB agents (if requested)
  if (opts?.includeDb) {
    try {
      const { loadDbAgents } = await import("../db/queries/agent-configs");
      const dbAgents = await loadDbAgents();
      for (const [name, def] of dbAgents) {
        agents.set(name, def);
      }
    } catch {
      // DB not available, skip
    }
  }

  return agents;
}

// ── Static loader (Workers / bundled) ───────────────────────────────

export function loadAgentsStatic(
  agents: AgentDefinition[],
): Map<string, AgentDefinition> {
  const map = new Map<string, AgentDefinition>();
  for (const agent of agents) map.set(agent.name, agent);
  return map;
}

// ── Validation ──────────────────────────────────────────────────────

function isValidAgent(val: unknown): val is AgentDefinition {
  if (val == null || typeof val !== "object") return false;
  const obj = val as Record<string, unknown>;
  return typeof obj.name === "string" && typeof obj.execute === "function";
}
