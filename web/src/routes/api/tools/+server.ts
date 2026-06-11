import { json } from "@sveltejs/kit";
import { ExtensionRegistry } from "$server/extensions/registry";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { ensureInitialized } from "$lib/server/context";
import { getBuiltInToolMetadata, getBuiltInCategoryDescription } from "$server/runtime/tools/builtin-registry";
import { applyToolFilters, ORCHESTRATION_TOOLS, type ToolFilterOptions } from "$server/runtime/tools/filter";
import { computeModeToolScope } from "$server/runtime/tools/mode-tool-scope";
import { getMode } from "$server/db/queries/modes";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, url }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  await ensureInitialized();

  const registry = ExtensionRegistry.getInstance();

  // ── Mode / conversation scoping ──
  // `?modeId=` and/or `?conversationId=` scope the listing to the tools
  // the runtime would actually grant for that mode + conversation. The
  // scope is computed by the SAME computeModeToolScope + applyToolFilters
  // pair the executor runs before every turn, so the header badge can
  // never show tools the mode doesn't allow (or hide ones it does).
  // A PRESENT modeId param is authoritative — it wins over the
  // conversation's persisted modeId so the client can reflect a
  // just-picked (or just-cleared: `modeId=`) mode without racing the
  // fire-and-forget PUT that persists it. The conversation's modeId is
  // only the fallback when the param is absent (first paint, panel).
  const conversationId = url.searchParams.get("conversationId");
  const hasModeParam = url.searchParams.has("modeId");
  let toolScope: ToolFilterOptions | null = null;
  if (conversationId || hasModeParam) {
    let convExtensionTools: Record<string, string[]> | null = null;
    let modeId = hasModeParam ? url.searchParams.get("modeId") || null : null;
    if (conversationId) {
      const owned = await resolveRootConversationForOwnership(conversationId, user);
      if (!owned) return json({ error: "Not found" }, { status: 404 });
      convExtensionTools = owned.conv.extensionTools ?? null;
      if (!hasModeParam) modeId = owned.conv.modeId ?? null;
    }
    const mode = modeId ? await getMode(modeId) : null;
    toolScope = computeModeToolScope(mode ?? null, convExtensionTools, registry);
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
  return json({ tools, count: tools.length, orchestrationTools });
};
