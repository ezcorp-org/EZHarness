import firstPartySources from "../../manifest.lock.json";
import type { AgentDefinition } from "../types";
import { CURRENT_MODEL_SENTINEL } from "../types";
import { configToAgent } from "../runtime/config-to-agent";
import type { DbTransaction } from "../db/connection";
import type { InstallationRecord, LifecycleRelease } from "./v4/types";
import { EZ_FACTORY_AGENTS, ensureEzFactoryAgents } from "./ez-factory-agents";
import { eq } from "drizzle-orm";
import { agentConfigs } from "../db/schema";
import { getDb } from "../db/connection";
import type { DbAgentConfig } from "../db/queries/agent-configs";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { requestedReleaseGrants } from "./extension-control";
import { canonicalJson } from "@ezcorp/extension-contract";

type AgentPublisher = (agents: AgentDefinition[]) => void;
const managedDefinitions = new WeakSet<AgentDefinition>();
let publisher: AgentPublisher | undefined;
let desiredAgents: AgentDefinition[] | undefined;

export function configureEzFactoryAgentPublisher(callback?: AgentPublisher): void {
  publisher = callback;
  if (!callback) desiredAgents = undefined;
  if (desiredAgents) publisher?.(desiredAgents);
}

export function publishEzFactoryAgents(agents: AgentDefinition[]): void {
  desiredAgents = agents;
  publisher?.(agents);
}

function isAttested(installation: InstallationRecord, release: LifecycleRelease | null | undefined): boolean {
  return Boolean(installation.enabled && !installation.uninstalled && release && release.id === installation.activeReleaseId && release.installationId === installation.id && release.manifest.name === "ez-factory" && release.sourceDigest === firstPartySources.sources["ez-factory"].sourceDigest);
}

function managedDefinition(row: DbAgentConfig): AgentDefinition {
  const definition = configToAgent({
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    capabilities: ["llm"],
    provider: CURRENT_MODEL_SENTINEL,
    model: CURRENT_MODEL_SENTINEL,
    outputFormat: "json",
  });
  managedDefinitions.add(definition);
  return definition;
}

export function isManagedFactoryAgent(definition: AgentDefinition): boolean {
  return managedDefinitions.has(definition);
}

export function assertManagedFactoryAgent(name: string, definitions: AgentDefinition[]): void {
  if (!EZ_FACTORY_AGENTS.some((agent) => agent.name === name)) return;
  const definition = definitions.find((agent) => agent.name === name);
  if (!definition || !isManagedFactoryAgent(definition)) throw new Error(`Approved host agent unavailable: ${name}`);
}

export function createEzFactoryAgentPublisher(executor: { listAgents(): AgentDefinition[]; registerAgent(definition: AgentDefinition): void; unregisterAgent(name: string): boolean }): AgentPublisher {
  const owned = new Map(executor.listAgents().filter(isManagedFactoryAgent).map((definition) => [definition.name, definition]));
  return (definitions) => {
    const current = new Map(executor.listAgents().map((definition) => [definition.name, definition]));
    for (const [name, definition] of owned) {
      if (current.get(name) === definition) {
        executor.unregisterAgent(name);
        current.delete(name);
      }
    }
    owned.clear();
    for (const definition of definitions) {
      if (current.has(definition.name)) continue;
      executor.registerAgent(definition);
      owned.set(definition.name, definition);
    }
  };
}

export async function loadManagedFactoryAgent(row: DbAgentConfig): Promise<AgentDefinition | null> {
  if (!row.managedByExtensionId || !EZ_FACTORY_AGENTS.some((agent) => agent.id === row.id && agent.name === row.name && agent.prompt === row.prompt) || row.outputFormat !== "json") return null;
  const state = await new DatabaseLifecycleRepository(getDb()).read(row.managedByExtensionId);
  if (!state || state.installation.acknowledgedGeneration !== state.installation.generation || !isAttested(state.installation, state.releases[state.installation.activeReleaseId ?? ""])) return null;
  if (canonicalJson([...new Set(state.installation.grants)].sort()) !== canonicalJson(requestedReleaseGrants(state.releases[state.installation.activeReleaseId!]!.manifest))) return null;
  return managedDefinition(row);
}

export async function prepareEzFactoryAgents(installation: InstallationRecord, release: LifecycleRelease | null, database: DbTransaction): Promise<AgentDefinition[]> {
  if (!isAttested(installation, release)) return [];
  const rows = await ensureEzFactoryAgents(database);
  for (const row of rows) {
    if ((row.userId && row.managedByExtensionId !== installation.id) || (row.managedByExtensionId && row.managedByExtensionId !== "legacy:ez-factory" && row.managedByExtensionId !== installation.id)) throw new Error(`Host agent configuration conflict: ${row.name}`);
    await database.update(agentConfigs).set({ managedByExtensionId: installation.id }).where(eq(agentConfigs.id, row.id));
  }
  return rows.map(managedDefinition);
}
