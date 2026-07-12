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
import { listExtensions } from "$server/db/queries/extensions";
import { getConversationExtensionIds } from "$server/db/queries/conversation-extensions";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import type { AuthUser } from "$server/auth/types";
import type { Mode } from "$server/db/schema";
import type { ExtensionManifestV2 } from "$server/extensions/types";

export interface ScopedToolRow {
  name: string;
  description: string;
  extension: string;
  extensionType: string;
  extensionDescription: string | undefined;
  /** Authored example user-phrasings (see `ToolDefinition.suggestExamples`).
   *  Surfaced ONLY for composer-suggestion retrieval — never billed into
   *  `tokenEstimate` and never sent to the LLM. Undefined for built-ins. */
  suggestExamples: string[] | undefined;
  tokenEstimate: number;
}

/**
 * An enabled extension eligible to be suggested as a whole (chip) in the
 * composer popover. Distinct from ScopedToolRow — this is EXTENSION-level
 * intent matching, not tool-level. See `resolveSuggestableExtensions`.
 */
export interface SuggestableExtension {
  name: string;
  description: string;
  /** Extension-level authored example phrasings (`ExtensionManifestV2.suggestExamples`). */
  suggestExamples: string[] | undefined;
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
    // `suggestExamples` is a composer-suggestion-only retrieval aid: the
    // tool-executor spec maps ONLY name/description/parameters, so examples
    // never reach the LLM and must NOT inflate the cost estimate the Tools
    // UI shows. Strip them before sizing, then carry them separately.
    const { suggestExamples, ...billable } = t;
    const tokenEstimate = Math.ceil(JSON.stringify(billable).length / 4);
    return { name, description: t.description, extension, extensionType, extensionDescription, suggestExamples, tokenEstimate };
  });

  // Built-in tools (task tracking, orchestration, scratchpad)
  // Group by category so they appear as separate sections in the UI
  const builtInTools = builtInMeta.map((t) => ({
    name: t.name,
    description: t.description,
    extension: t.category,
    extensionType: "built-in",
    extensionDescription: getBuiltInCategoryDescription(t.category),
    // Built-ins carry no authored examples — always wired, never suggested
    // as an extension chip.
    suggestExamples: undefined,
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

/**
 * True when a mode curates its own tool/extension surface — either by
 * pinning specific extensions (`extensionIds`) or by carrying a
 * `toolRestriction` that actually narrows ("read-only" / "none" /
 * "allowlist"). Whole-extension suggestions are suppressed in that case:
 * the mode already decides which extensions belong, so proposing an
 * unwired one would contradict its curation. `"all"` is NOT a
 * restriction — it is the stored default on every mode row
 * (`tool_restriction` is notNull default "all") and `applyToolFilters`
 * treats it as "no category-level filter", so a plain mode leaves the
 * registry-wide surface open, where extension chips are meaningful.
 */
export function isModeToolRestricted(
  mode: Pick<Mode, "extensionIds" | "toolRestriction"> | null,
): boolean {
  return (
    !!mode &&
    ((mode.extensionIds?.length ?? 0) > 0 ||
      (!!mode.toolRestriction && mode.toolRestriction !== "all"))
  );
}

/**
 * Resolve the enabled extensions eligible to be suggested as a whole in the
 * composer popover: every enabled extension MINUS the ones already wired
 * into the conversation (matched on extension IDS, not names), keeping only
 * those with a non-empty manifest description (the retrieval signal). This
 * is a pure DB read — it performs NO ownership check on the conversation,
 * so callers MUST gate it behind `resolveScopedTools`' fail-closed (null →
 * 404) result, exactly as the composer suggest route does.
 */
export async function resolveSuggestableExtensions(
  conversationId: string | null,
): Promise<SuggestableExtension[]> {
  const enabled = await listExtensions(true);
  const wiredIds = conversationId
    ? new Set(await getConversationExtensionIds(conversationId))
    : new Set<string>();
  const out: SuggestableExtension[] = [];
  for (const ext of enabled) {
    if (wiredIds.has(ext.id)) continue;
    const manifest = ext.manifest as ExtensionManifestV2;
    if (!manifest.description || manifest.description.trim().length === 0) continue;
    out.push({
      name: ext.name,
      description: manifest.description,
      suggestExamples: manifest.suggestExamples,
    });
  }
  return out;
}
