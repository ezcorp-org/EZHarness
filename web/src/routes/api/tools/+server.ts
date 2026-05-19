import { json } from "@sveltejs/kit";
import { ExtensionRegistry } from "$server/extensions/registry";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { ensureInitialized } from "$lib/server/context";
import { getBuiltInToolMetadata } from "$server/runtime/tools/builtin-registry";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  await ensureInitialized();

  const registry = ExtensionRegistry.getInstance();
  const allExtTools = registry.getAllTools();

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
    const tokenEstimate = Math.ceil(JSON.stringify(t).length / 4);
    return { name, description: t.description, extension, extensionType, tokenEstimate };
  });

  // Built-in tools (task tracking, orchestration, scratchpad)
  // Group by category so they appear as separate sections in the UI
  const builtInTools = getBuiltInToolMetadata().map((t) => ({
    name: t.name,
    description: t.description,
    extension: t.category,
    extensionType: "built-in",
    tokenEstimate: Math.ceil((t.name.length + t.description.length) / 4),
  }));

  const tools = [...builtInTools, ...extensionTools];
  return json({ tools, count: tools.length });
};
