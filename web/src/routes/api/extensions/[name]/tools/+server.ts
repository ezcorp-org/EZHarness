import { json } from "@sveltejs/kit";
import { ExtensionRegistry } from "$server/extensions/registry";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { ensureInitialized } from "$lib/server/context";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  await ensureInitialized();

  const extensionName = params.name;
  const registry = ExtensionRegistry.getInstance();

  // Find tools that belong to this extension (namespaced as extensionName.toolName)
  const allTools = registry.getAllTools();
  const extensionTools = allTools.filter(t => t.name.startsWith(`${extensionName}.`));

  if (extensionTools.length === 0) {
    // Check if this is a built-in tool category (e.g. "task-tracking", "scratchpad")
    const { getBuiltInToolsByCategory } = await import("$server/runtime/tools/builtin-registry");
    const builtinTools = getBuiltInToolsByCategory(extensionName);
    if (builtinTools.length > 0) {
      return json({ tools: builtinTools });
    }
    return errorJson(404, `No tools found for extension: ${extensionName}`);
  }

  return json({
    tools: extensionTools.map(t => ({
      name: t.name.slice(extensionName.length + 1), // Strip namespace prefix
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  });
};
