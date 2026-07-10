/**
 * Mode/conversation-scoped tool listing — the shared core behind
 * GET /api/tools and POST /api/composer/suggest.
 *
 * The scope is computed by the SAME computeModeToolScope + applyToolFilters
 * pair the executor runs before every turn, so consumers can never show (or
 * rank) tools the mode doesn't allow — or hide ones it does.
 *
 * A PRESENT modeId (hasModeParam) is authoritative — it wins over the
 * conversation's persisted modeId so callers can reflect a just-picked (or
 * just-cleared: modeId=null) mode without racing the fire-and-forget PUT
 * that persists it. The conversation's modeId is only the fallback when the
 * param is absent (first paint, panel).
 */
import { ExtensionRegistry } from "$server/extensions/registry";
import {
  getBuiltInToolMetadata,
  getBuiltInCategoryDescription,
} from "$server/runtime/tools/builtin-registry";
import {
  applyToolFilters,
  ORCHESTRATION_TOOLS,
  type ToolFilterOptions,
} from "$server/runtime/tools/filter";
import { computeModeToolScope } from "$server/runtime/tools/mode-tool-scope";
import { getMode } from "$server/db/queries/modes";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import type { AuthUser } from "$server/auth/types";
import type { Mode } from "$server/db/schema";

export interface ScopedToolRow {
  name: string;
  description: string;
  extension: string;
  extensionType: string;
  extensionDescription: string | undefined;
  tokenEstimate: number;
}

export interface ScopedToolsResult {
  tools: ScopedToolRow[];
  /** Namespaced names of the always-wired orchestration tools that are
   *  ACTUALLY loaded — conv/mode-INDEPENDENT on purpose (see below). */
  orchestrationTools: string[];
  /** The mode that scoped the listing (explicit param or the conversation's
   *  persisted one), when it resolved. */
  mode: Mode | null;
  /** The scoping conversation's project — authoritative over any
   *  client-supplied projectId; null when no conversation scoped the call. */
  projectId: string | null;
}

export interface ScopedToolsOptions {
  conversationId: string | null;
  modeId: string | null;
  /** True when the caller SUPPLIED a modeId (even an empty/null one) —
   *  presence makes it authoritative over the conversation's row. */
  hasModeParam: boolean;
}

/**
 * Resolve the tool surface for a user + mode/conversation scope.
 * Returns null when the conversation doesn't exist or isn't owned by the
 * caller (fail-closed — callers respond 404 without an existence leak).
 */
export async function resolveScopedTools(
  user: AuthUser,
  opts: ScopedToolsOptions,
): Promise<ScopedToolsResult | null> {
  const registry = ExtensionRegistry.getInstance();

  const { conversationId, hasModeParam } = opts;
  let toolScope: ToolFilterOptions | null = null;
  let mode: Mode | null = null;
  let projectId: string | null = null;
  if (conversationId || hasModeParam) {
    let convExtensionTools: Record<string, string[]> | null = null;
    let modeId = hasModeParam ? opts.modeId || null : null;
    if (conversationId) {
      const owned = await resolveRootConversationForOwnership(conversationId, user);
      if (!owned) return null;
      convExtensionTools = owned.conv.extensionTools ?? null;
      projectId = owned.conv.projectId ?? null;
      if (!hasModeParam) modeId = owned.conv.modeId ?? null;
    }
    mode = modeId ? ((await getMode(modeId)) ?? null) : null;
    toolScope = computeModeToolScope(mode, convExtensionTools, registry);
  }

  let allExtTools = registry.getAllTools();
  let builtInMeta = getBuiltInToolMetadata();
  // Capture the UNSCOPED tool surface before any mode/conversation filtering
  // reassigns the variables — orchestrationTools below must stay
  // conv/mode-independent.
  const loadedToolNames = new Set([...allExtTools, ...builtInMeta].map((t) => t.name));
  if (toolScope) {
    // Category map mirrors the executor's builtinToolDefsMap role for the
    // 'read-only' restriction; extension tools absent from it drop there,
    // exactly like the runtime filter.
    const builtinDefs = new Map(builtInMeta.map((t) => [t.name, { category: t.category }]));
    allExtTools = applyToolFilters(allExtTools, builtinDefs, toolScope);
    builtInMeta = applyToolFilters(builtInMeta, builtinDefs, toolScope);
  }

  // Extension tools (from sandboxed extensions).
  // ExtensionRegistry registers tools as `${manifest.name}__${toolName}`
  // — the Anthropic tool-name regex `^[a-zA-Z0-9_-]+$` forbids dots, so the
  // project uses `__` (double underscore) as the separator. Split on that,
  // not `.`, or every extension tool lands under extension="unknown" and
  // downstream consumers (TeamBuilderForm's toolNamesByExtension map,
  // ToolSearchPicker's "${ext}__${name}" toggle key) stop matching
  // registered tool names.
  const extensionTools = allExtTools.map((t) => {
    const sep = t.name.indexOf("__");
    const extension = sep >= 0 ? t.name.slice(0, sep) : "unknown";
    const name = sep >= 0 ? t.name.slice(sep + 2) : t.name;
    const extensionType = registry.getExtensionType(extension);
    const extensionDescription = registry.getExtensionDescription(extension);
    const tokenEstimate = Math.ceil(JSON.stringify(t).length / 4);
    return { name, description: t.description, extension, extensionType, extensionDescription, tokenEstimate };
  });

  // Built-in tools (task tracking, orchestration, scratchpad)
  // Group by category so they appear as separate sections in the UI
  const builtInTools = builtInMeta.map((t) => ({
    name: t.name,
    description: t.description,
    extension: t.category,
    extensionType: "built-in",
    extensionDescription: getBuiltInCategoryDescription(t.category),
    tokenEstimate: Math.ceil((t.name.length + t.description.length) / 4),
  }));

  const tools = [...builtInTools, ...extensionTools];
  // Namespaced names of the orchestration tools that are ACTUALLY loaded:
  // ORCHESTRATION_TOOLS intersected with the unscoped tool surface (extension
  // registry + built-ins, BEFORE mode/conversation scoping). A disabled
  // orchestration extension (e.g. scratchpad) is never advertised — its tools
  // don't exist in the runtime. The list stays conv/mode-INDEPENDENT on
  // purpose: if a conversation toggles ask-user off, the composer's Tools
  // dropdown must still list it so the user can re-enable it.
  const orchestrationTools = [...ORCHESTRATION_TOOLS].filter((name) => loadedToolNames.has(name));

  return { tools, orchestrationTools, mode, projectId };
}

/**
 * Stable candidate key for ranking/telemetry: the runtime tool name —
 * namespaced for extension tools, bare for built-ins (mirrors how
 * tool_calls.tool_name is recorded).
 */
export function scopedToolKey(tool: Pick<ScopedToolRow, "name" | "extension" | "extensionType">): string {
  return tool.extensionType === "built-in" ? tool.name : `${tool.extension}__${tool.name}`;
}
