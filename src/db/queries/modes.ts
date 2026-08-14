import { eq, or } from "drizzle-orm";
import { getDb } from "../connection";
import { modes } from "../schema";
// Tier vocabulary lives in the pure routing classifier (single source of
// truth). Type-only import — erased at build, so it adds no runtime dep.
import type { RoutingTier } from "../../runtime/tier-classifier";

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

/**
 * The single-row form of {@link listModes}'s visibility rule: a caller sees a
 * mode when it is `builtin` or their own. Use this — never bare `getMode` —
 * wherever a caller-supplied mode id is about to be WRITTEN to a row, so the
 * two forms of "which modes are mine" can never disagree.
 *
 * An ownerless non-builtin mode (`userId === null`) stays visible to everyone.
 * That is deliberate, not an oversight: `modes.userId` is `ON DELETE SET NULL`,
 * so deleting a user orphans their modes rather than deleting them, and
 * refusing orphans would take working modes away from every conversation
 * already using one. `listModes` is narrower here — its `or(builtin, userId =
 * caller)` never matches a NULL owner — but a mode you cannot list is not the
 * same as a mode you must not keep using, and the conversations that already
 * reference one are exactly the callers who need it.
 *
 * Returns `null` for both "no such mode" and "not yours" so callers answer a
 * single fail-closed 404 and the endpoint is not an existence oracle.
 */
export async function getVisibleMode(
  id: string,
  userId: string,
): Promise<DbMode | null> {
  const mode = await getMode(id);
  if (!mode) return null;
  if (!mode.builtin && mode.userId && mode.userId !== userId) return null;
  return mode;
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
  /** WS3b: the routing tier this kind of task wants, when the mode has no
   *  reason to name a specific model. Applied at thread start as the tier
   *  classifier's hint (src/runtime/routing/mode-binding.ts). */
  preferredTier?: RoutingTier | null;
  preferredThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  temperature?: number | null;
  toolRestriction?: "all" | "read-only" | "none" | "allowlist";
  /** Phase 48: only meaningful when toolRestriction === 'allowlist'. */
  allowedTools?: string[] | null;
  /** When non-empty, the runtime expands the union of these extensions'
   *  tool names into the effective allowlist (overrides toolRestriction). */
  extensionIds?: string[] | null;
  /** Per-extension tool subset (extension id → selected tool names). Absent /
   *  empty for an attached extension means all its tools. */
  extensionTools?: Record<string, string[]> | null;
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
    preferredTier: data.preferredTier ?? null,
    // biome-ignore lint/suspicious/noExplicitAny: the column is typed to pi-ai's ModelThinkingLevel union while the caller's DTO carries a plain string; an unknown level is rejected downstream by the thinking-level resolver, not here.
    preferredThinkingLevel: (data.preferredThinkingLevel ?? null) as any,
    temperature: data.temperature ?? null,
    toolRestriction: (data.toolRestriction ?? "all") as "all" | "read-only" | "none" | "allowlist",
    allowedTools: data.allowedTools ?? null,
    extensionIds: data.extensionIds ?? null,
    extensionTools: data.extensionTools ?? null,
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
  preferredTier: RoutingTier | null;
  preferredThinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  temperature: number | null;
  toolRestriction: "all" | "read-only" | "none" | "allowlist";
  allowedTools: string[] | null;
  extensionIds: string[] | null;
  extensionTools: Record<string, string[]> | null;
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
