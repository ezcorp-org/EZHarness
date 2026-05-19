import type { AgentConfig, AgentDefinition } from "../types";
import { configToAgent } from "./config-to-agent";
import { parse } from "yaml";
import { logger } from "../logger";
const log = logger.child("loader");

export async function loadYamlAgents(
  dir: string,
): Promise<Map<string, AgentDefinition>> {
  const agents = new Map<string, AgentDefinition>();
  const glob = new Bun.Glob("*.agent.yaml");

  for await (const file of glob.scan({ cwd: dir, absolute: true })) {
    try {
      const content = await Bun.file(file).text();
      const config = parse(content) as AgentConfig;

      if (!config.name || !config.prompt) {
        log.warn("Skipping YAML agent: missing required name or prompt", { file });
        continue;
      }

      config.capabilities ??= ["llm"];
      config.description ??= "";

      agents.set(config.name, configToAgent(config));
    } catch (err) {
      log.warn("Failed to load YAML agent", { file, error: String(err) });
    }
  }

  return agents;
}
