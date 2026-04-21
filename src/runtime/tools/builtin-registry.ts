/**
 * Metadata for remaining built-in tools (orchestration).
 * Used by the /api/tools endpoint to include built-in tools alongside
 * extension tools, and by the mention search / tool-invoke APIs.
 *
 * After Phase 3 commit-5 the task-tracking tools moved to a bundled
 * extension and their metadata flows through the extensions table like
 * every other extension. Only the two orchestration tools remain.
 */

export type BuiltInCategory = "orchestration";

export interface BuiltInToolMeta {
  name: string;
  description: string;
  category: BuiltInCategory;
  inputSchema?: Record<string, unknown>;
  /** Whether this tool's category is mentionable in chat via @. Defaults to true. */
  mentionable?: boolean;
}

/** Build the full tool list. */
function buildToolList(): BuiltInToolMeta[] {
  return [
    // Orchestration (2) — not mentionable (require active run context).
    // (Scratchpad moved to a bundled extension in Phase 1; task-tracking
    // moved to a bundled extension in Phase 3 commit-5.)
    { name: "invoke_agent", description: "Invoke a specialized agent to handle a task. The agent runs as an independent sub-conversation and returns its response.", category: "orchestration", mentionable: false },
    { name: "ask_human", description: "Pause execution and ask the user a question. The agent will wait for the user's response before continuing.", category: "orchestration", mentionable: false },
  ];
}

let _cachedTools: BuiltInToolMeta[] | undefined;
function getTools(): BuiltInToolMeta[] {
  if (!_cachedTools) _cachedTools = buildToolList();
  return _cachedTools;
}

export function getBuiltInToolMetadata(): BuiltInToolMeta[] {
  return getTools();
}

/** Category descriptions for mention search results. */
const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  // Task-tracking category removed in Phase 3 commit-5 — the bundled
  // extension now surfaces in the mention picker via the standard
  // extensions-table path in web/src/routes/api/mentions/search/+server.ts.
  // Scratchpad category was removed the same way in Phase 1.
};

/** Get mentionable built-in categories for the mention search API. */
export function getBuiltInCategories(): Array<{ name: string; description: string }> {
  const seen = new Set<string>();
  const categories: Array<{ name: string; description: string }> = [];
  for (const t of getTools()) {
    if (t.mentionable === false || seen.has(t.category)) continue;
    seen.add(t.category);
    categories.push({ name: t.category, description: CATEGORY_DESCRIPTIONS[t.category] ?? t.category });
  }
  return categories;
}

/** Get tool definitions (with schemas) for a built-in category. */
export function getBuiltInToolsByCategory(category: string): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return getTools()
    .filter(t => t.category === category && t.inputSchema)
    .map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema! }));
}
