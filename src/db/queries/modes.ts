import { eq, or } from "drizzle-orm";
import { getDb } from "../connection";
import { modes } from "../schema";

export type DbMode = typeof modes.$inferSelect;

export async function listModes(userId?: string): Promise<DbMode[]> {
  const db = getDb();
  if (userId) {
    return db.select().from(modes).where(
      or(eq(modes.builtin, true), eq(modes.userId, userId))
    );
  }
  return db.select().from(modes);
}

export async function getMode(id: string): Promise<DbMode | undefined> {
  const rows = await getDb().select().from(modes).where(eq(modes.id, id));
  return rows[0];
}

export async function getModeBySlug(slug: string): Promise<DbMode | undefined> {
  const rows = await getDb().select().from(modes).where(eq(modes.slug, slug));
  return rows[0];
}

export async function createMode(data: {
  name: string;
  slug: string;
  icon?: string | null;
  description?: string;
  systemPromptInstruction: string;
  instructionPosition?: "prepend" | "append" | "replace";
  preferredModel?: string | null;
  preferredProvider?: string | null;
  preferredThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  temperature?: number | null;
  toolRestriction?: "all" | "read-only" | "none" | "allowlist";
  /** Phase 48: only meaningful when toolRestriction === 'allowlist'. */
  allowedTools?: string[] | null;
  /** When non-empty, the runtime expands the union of these extensions'
   *  tool names into the effective allowlist (overrides toolRestriction). */
  extensionIds?: string[] | null;
  userId?: string | null;
}): Promise<DbMode> {
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    name: data.name,
    slug: data.slug,
    icon: data.icon ?? null,
    description: data.description ?? "",
    systemPromptInstruction: data.systemPromptInstruction,
    instructionPosition: (data.instructionPosition ?? "prepend") as "prepend" | "append" | "replace",
    preferredModel: data.preferredModel ?? null,
    preferredProvider: data.preferredProvider ?? null,
    preferredThinkingLevel: (data.preferredThinkingLevel ?? null) as any,
    temperature: data.temperature ?? null,
    toolRestriction: (data.toolRestriction ?? "all") as "all" | "read-only" | "none" | "allowlist",
    allowedTools: data.allowedTools ?? null,
    extensionIds: data.extensionIds ?? null,
    builtin: false,
    userId: data.userId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await getDb().insert(modes).values(row);
  return row;
}

export async function updateMode(id: string, data: Partial<{
  name: string;
  slug: string;
  icon: string | null;
  description: string;
  systemPromptInstruction: string;
  instructionPosition: "prepend" | "append" | "replace";
  preferredModel: string | null;
  preferredProvider: string | null;
  preferredThinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  temperature: number | null;
  toolRestriction: "all" | "read-only" | "none" | "allowlist";
  allowedTools: string[] | null;
  extensionIds: string[] | null;
}>): Promise<DbMode | undefined> {
  const existing = await getMode(id);
  if (!existing || existing.builtin) return undefined;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined) updates[key] = val;
  }

  await getDb().update(modes).set(updates).where(eq(modes.id, id));
  return getMode(id);
}

export async function deleteMode(id: string): Promise<boolean> {
  const existing = await getMode(id);
  if (!existing || existing.builtin) return false;
  await getDb().delete(modes).where(eq(modes.id, id));
  return true;
}
