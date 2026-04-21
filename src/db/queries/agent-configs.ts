import { eq } from "drizzle-orm";
import { getDb } from "../connection";
import { agentConfigs } from "../schema";
import { configToAgent } from "../../runtime/config-to-agent";
import { CURRENT_MODEL_SENTINEL, type AgentConfig, type AgentDefinition, type InputSchema, type TeamMember } from "../../types";
import { getSharedAgentsForUser } from "./agent-shares";
import { detectCycle } from "../../runtime/dag-validator";

export function flattenMemberIds(members: TeamMember[]): string[] {
  const ids: string[] = [];
  function walk(ms: TeamMember[]) {
    for (const m of ms) {
      ids.push(m.agentConfigId);
      if (m.subAgents?.length) walk(m.subAgents);
    }
  }
  walk(members);
  return [...new Set(ids)];
}

export class AgentValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "AgentValidationError";
  }
}

async function validateReferences(agentId: string, references: { agents?: string[]; extensions?: string[] }): Promise<void> {
  const agentRefs = references.agents ?? [];
  if (agentRefs.length === 0) return;

  // Build allRefs map from all existing agent configs
  const allConfigs = await getDb().select().from(agentConfigs);
  const allRefs = new Map<string, string[]>();
  const nameById = new Map<string, string>();
  for (const cfg of allConfigs) {
    const refs = (cfg.references as { agents?: string[]; extensions?: string[] } | null)?.agents ?? [];
    allRefs.set(cfg.id, refs);
    nameById.set(cfg.id, cfg.name);
  }

  const cycle = detectCycle(agentId, agentRefs, allRefs);
  if (cycle) {
    const names = cycle.map(id => nameById.get(id) ?? id);
    throw new AgentValidationError(`Circular reference: ${names.join(" -> ")}`);
  }
}

export type DbAgentConfig = typeof agentConfigs.$inferSelect;

export interface AgentListEntry {
  name: string;
  description: string;
  capabilities: string[];
  inputSchema?: Record<string, unknown>;
  source: "file" | "config";
  id: string | null;
  prompt: string | null;
  category: string | null;
  shared?: boolean;
  sharedBy?: string;
  sharedByName?: string;
}

export async function listAgentConfigs(userId?: string): Promise<(DbAgentConfig & { shared?: boolean; sharedBy?: string; sharedByName?: string })[]> {
  if (userId) {
    const owned = await getDb().select().from(agentConfigs).where(eq(agentConfigs.userId, userId));
    const ownedWithFlag = owned.map((a: DbAgentConfig) => ({ ...a, shared: false }));

    const shared = await getSharedAgentsForUser(userId);
    // Deduplicate: skip shared agents the user already owns
    const ownedIds = new Set(owned.map((a: DbAgentConfig) => a.id));
    const uniqueShared = shared.filter((a) => !ownedIds.has(a.id));

    return [...ownedWithFlag, ...uniqueShared];
  }
  return getDb().select().from(agentConfigs);
}

export async function getAgentConfig(id: string): Promise<DbAgentConfig | undefined> {
  const rows = await getDb().select().from(agentConfigs).where(eq(agentConfigs.id, id));
  return rows[0];
}

export async function getAgentConfigByName(name: string): Promise<DbAgentConfig | undefined> {
  const rows = await getDb().select().from(agentConfigs).where(eq(agentConfigs.name, name));
  return rows[0];
}

export async function createAgentConfig(data: Omit<AgentConfig, "capabilities"> & { capabilities?: string[]; category?: string | null; userId?: string; references?: { agents?: string[]; extensions?: string[]; members?: TeamMember[]; autoSpinUp?: boolean; teamToolScope?: import("../../types").TeamToolScope } }): Promise<DbAgentConfig> {
  const now = new Date();
  const id = crypto.randomUUID();
  if (data.references?.members?.length) {
    const memberIds = flattenMemberIds(data.references.members);
    const existing = new Set(data.references.agents ?? []);
    for (const mid of memberIds) existing.add(mid);
    data.references.agents = [...existing];
  }
  if (data.references?.agents?.length) {
    await validateReferences(id, data.references);
  }
  const row = {
    id,
    name: data.name,
    description: data.description ?? "",
    capabilities: data.capabilities ?? ["llm"],
    prompt: data.prompt,
    inputSchema: (data.inputSchema as Record<string, unknown>) ?? null,
    outputFormat: data.outputFormat ?? "text",
    provider: data.provider ?? CURRENT_MODEL_SENTINEL,
    model: data.model ?? CURRENT_MODEL_SENTINEL,
    temperature: data.temperature ?? null,
    maxTokens: data.maxTokens ?? null,
    category: data.category ?? null,
    extensions: (data as { extensions?: string[] }).extensions ?? [],
    references: {
      agents: data.references?.agents ?? [],
      extensions: data.references?.extensions ?? [],
      ...(data.references?.members?.length ? { members: data.references.members } : {}),
      ...(data.references?.autoSpinUp != null ? { autoSpinUp: data.references.autoSpinUp } : {}),
      ...(data.references?.teamToolScope ? { teamToolScope: data.references.teamToolScope } : {}),
    },
    userId: data.userId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await getDb().insert(agentConfigs).values(row);
  return row;
}

export async function updateAgentConfig(id: string, data: Partial<AgentConfig> & { category?: string | null; references?: { agents?: string[]; extensions?: string[]; members?: TeamMember[]; autoSpinUp?: boolean; teamToolScope?: import("../../types").TeamToolScope } }): Promise<DbAgentConfig | undefined> {
  const existing = await getAgentConfig(id);
  if (!existing) return undefined;

  if (data.references?.members?.length) {
    const memberIds = flattenMemberIds(data.references.members);
    const existingIds = new Set(data.references.agents ?? []);
    for (const mid of memberIds) existingIds.add(mid);
    data.references.agents = [...existingIds];
  }
  if (data.references?.agents?.length) {
    await validateReferences(id, data.references);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;
  if (data.capabilities !== undefined) updates.capabilities = data.capabilities;
  if (data.prompt !== undefined) updates.prompt = data.prompt;
  if (data.inputSchema !== undefined) updates.inputSchema = data.inputSchema;
  if (data.outputFormat !== undefined) updates.outputFormat = data.outputFormat;
  if (data.provider !== undefined) updates.provider = data.provider;
  if (data.model !== undefined) updates.model = data.model;
  if (data.temperature !== undefined) updates.temperature = data.temperature;
  if (data.maxTokens !== undefined) updates.maxTokens = data.maxTokens;
  if (data.category !== undefined) updates.category = data.category;
  if ((data as { extensions?: string[] }).extensions !== undefined) {
    updates.extensions = (data as { extensions?: string[] }).extensions;
  }
  if (data.references !== undefined) updates.references = {
    agents: data.references?.agents ?? [],
    extensions: data.references?.extensions ?? [],
    ...(data.references?.members?.length ? { members: data.references.members } : {}),
    ...(data.references?.autoSpinUp != null ? { autoSpinUp: data.references.autoSpinUp } : {}),
    ...(data.references?.teamToolScope ? { teamToolScope: data.references.teamToolScope } : {}),
  };

  await getDb().update(agentConfigs).set(updates).where(eq(agentConfigs.id, id));
  return getAgentConfig(id);
}

export async function deleteAgentConfig(id: string): Promise<boolean> {
  const existing = await getAgentConfig(id);
  if (!existing) return false;
  await getDb().delete(agentConfigs).where(eq(agentConfigs.id, id));
  return true;
}

function dbConfigToAgentConfig(row: DbAgentConfig): AgentConfig {
  return {
    name: row.name,
    description: row.description,
    capabilities: row.capabilities as AgentConfig["capabilities"],
    prompt: row.prompt,
    inputSchema: row.inputSchema as InputSchema | undefined,
    outputFormat: (row.outputFormat as "text" | "json") ?? "text",
    provider: row.provider as AgentConfig["provider"],
    model: row.model ?? undefined,
    temperature: row.temperature ?? undefined,
    maxTokens: row.maxTokens ?? undefined,
  };
}

export async function listDbAgentEntries(userId?: string): Promise<AgentListEntry[]> {
  const configs = await listAgentConfigs(userId);
  return configs.map((row) => ({
    name: row.name,
    description: row.description,
    capabilities: row.capabilities as string[],
    inputSchema: row.inputSchema as Record<string, unknown> | undefined,
    source: "config" as const,
    id: row.id,
    prompt: row.prompt,
    category: row.category ?? null,
    shared: (row as any).shared ?? false,
    sharedBy: (row as any).sharedBy,
    sharedByName: (row as any).sharedByName,
  }));
}

export async function loadDbAgents(): Promise<Map<string, AgentDefinition>> {
  const agents = new Map<string, AgentDefinition>();
  const configs = await listAgentConfigs();
  for (const row of configs) {
    agents.set(row.name, configToAgent(dbConfigToAgentConfig(row)));
  }
  return agents;
}
