import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { validateManifestV2 } from "$server/extensions/manifest";
import { createAgentConfig, getAgentConfigByName } from "$server/db/queries/agent-configs";
import { upsertSetting } from "$server/db/queries/settings";
import { importManifestSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";
import type { ExtensionManifestV2 } from "$server/extensions/types";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const parseResult = importManifestSchema.safeParse(await request.json());
  if (!parseResult.success) {
    return validationError(parseResult.error);
  }
  const manifest = parseResult.data as ExtensionManifestV2;

  const validation = validateManifestV2(manifest);
  if (!validation.valid) {
    return json({ error: "Invalid manifest", errors: validation.errors }, { status: 400 });
  }

  if (manifest.agent) {
    // Handle name collision
    let name = manifest.name;
    const existing = await getAgentConfigByName(name);
    if (existing) {
      name = `${name} (Imported)`;
    }

    const agentConfig = await createAgentConfig({
      name,
      description: manifest.description,
      prompt: manifest.agent.prompt,
      capabilities: manifest.agent.capabilities as any,
      category: manifest.agent.category,
      temperature: manifest.agent.temperature,
      maxTokens: manifest.agent.maxTokens,
      outputFormat: manifest.agent.outputFormat,
      inputSchema: manifest.agent.inputSchema as any,
      userId: user.id,
    });

    await upsertSetting(`marketplace:imported:${agentConfig.id}`, {
      source: "import",
      originalName: manifest.name,
      originalAuthor: manifest.author?.name,
      importedAt: new Date().toISOString(),
    });

    return json(
      { agentConfig, extensionsNeeded: [] },
      { status: 201 },
    );
  }

  return json({ error: "Manifest must include an agent component to be imported" }, { status: 400 });
};
