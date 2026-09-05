import firstPartySources from "../../manifest.lock.json";
import type { AgentDefinition } from "../types";
import { CURRENT_MODEL_SENTINEL } from "../types";
import { configToAgent } from "../runtime/config-to-agent";
import type { DbTransaction } from "../db/connection";
import type { InstallationRecord, LifecycleRelease } from "./v4/types";
import { EZ_FACTORY_AGENTS, ensureEzFactoryAgents } from "./ez-factory-agents";

type AgentPublisher = (agents: AgentDefinition[], names: readonly string[]) => void;
const names = EZ_FACTORY_AGENTS.map((agent) => agent.name);
let publisher: AgentPublisher | undefined;
let desiredAgents: AgentDefinition[] = [];

export function configureEzFactoryAgentPublisher(callback?: AgentPublisher): void {
  publisher = callback;
  if (!callback) desiredAgents = [];
  publisher?.(desiredAgents, names);
}

export function publishEzFactoryAgents(agents: AgentDefinition[]): void {
  desiredAgents = agents;
  publisher?.(agents, names);
}

export async function prepareEzFactoryAgents(installation: InstallationRecord, release: LifecycleRelease | null, database: DbTransaction): Promise<AgentDefinition[]> {
  if (!installation.enabled || installation.uninstalled || !release || release.id !== installation.activeReleaseId || release.installationId !== installation.id || release.manifest.name !== "ez-factory" || release.sourceDigest !== firstPartySources.sources["ez-factory"].sourceDigest) return [];
  const rows = await ensureEzFactoryAgents(database);
  return rows.map((row) => configToAgent({
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    capabilities: ["llm"],
    provider: CURRENT_MODEL_SENTINEL,
    model: CURRENT_MODEL_SENTINEL,
    outputFormat: "json",
  }));
}
