import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { z } from "zod";
import { apiRegistry } from "../../../../../src/api-registry";
import { requireScope } from "$lib/server/security/api-keys";

// Import all Zod schemas from their source files
import { loginSchema } from "../auth/login/schema";
import { setupSchema } from "../auth/setup/schema";
import { createInviteSchema } from "../auth/invite/schema";
import { generateResetSchema, consumeResetSchema } from "../auth/reset-password/schema";
import { createConversationSchema, updateConversationSchema } from "../conversations/schema";
import { createMessageSchema } from "../conversations/[id]/messages/schema";
import { rewindConversationSchema } from "../conversations/[id]/rewind/schema";
import { createAgentConfigSchema } from "../agent-configs/schema";
import { generateAgentConfigSchema } from "../agent-configs/generate/schema";
import { runAgentSchema } from "../agents/[name]/run/schema";
import { installExtensionSchema } from "../extensions/schema";
import { publishListingSchema } from "../marketplace/schema";
import { importManifestSchema } from "../marketplace/import/schema";
import { createApiKeySchema } from "../settings/developer/schema";
import { suggestRequestSchema, suggestFeedbackSchema } from "../composer/suggest/schema";

/** Map of schemaKey -> Zod schema for JSON Schema conversion */
const schemaMap: Record<string, z.ZodType> = {
  loginSchema,
  setupSchema,
  createInviteSchema,
  generateResetSchema,
  consumeResetSchema,
  createConversationSchema,
  updateConversationSchema,
  createMessageSchema,
  rewindConversationSchema,
  createAgentConfigSchema,
  generateAgentConfigSchema,
  runAgentSchema,
  installExtensionSchema,
  publishListingSchema,
  importManifestSchema,
  createApiKeySchema,
  suggestRequestSchema,
  suggestFeedbackSchema,
};

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const routes = apiRegistry.map((entry) => {
    let requestJsonSchema: Record<string, unknown> | undefined;

    if (entry.schemaKey && schemaMap[entry.schemaKey]) {
      try {
        requestJsonSchema = z.toJSONSchema(schemaMap[entry.schemaKey]!, {
          target: "draft-07",
          unrepresentable: "any",
        }) as Record<string, unknown>;
      } catch {
        // Schema conversion failed -- omit silently
      }
    }

    return {
      method: entry.method,
      path: entry.path,
      description: entry.description,
      category: entry.category,
      responseDescription: entry.responseDescription,
      ...(requestJsonSchema && { requestJsonSchema }),
    };
  });

  return json({ routes });
};
