import { json } from "@sveltejs/kit";
import { z } from "zod";
import { ExtensionRegistry } from "$server/extensions/registry";
import { ToolExecutor } from "$server/extensions/tool-executor";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { ensureInitialized, getBus } from "$lib/server/context";
import { ensureTaskTrackingWired } from "$server/runtime/task-tracking-host";
import type { RequestHandler } from "./$types";

const MAX_RETRIES = 2;

// Boundary validation. POST invokes a registered extension tool by
// `extensionName__toolName`; `input` is forwarded to the tool whose
// own input schema validates it, so we keep `input` loose here. The
// existing presence check downstream still drives the
// "Missing required fields" 400 message verbatim — the test contract
// asserts on that exact prefix. Strict mode rejects unknown top-level
// keys.
const postBodySchema = z.object({
  extensionName: z.string().optional(),
  toolName: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  conversationId: z.string().optional(),
  invocationId: z.string().optional(),
  messageId: z.string().optional(),
}).strict();

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  await ensureInitialized();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = postBodySchema.safeParse(raw);
  if (!parsed.success) {
    return json({ success: false, error: "Missing required fields: extensionName, toolName, conversationId, invocationId" }, { status: 400 });
  }
  const { extensionName, toolName, input, conversationId, invocationId, messageId } = parsed.data;
  if (!extensionName || !toolName || !conversationId || !invocationId) {
    return json({ success: false, error: "Missing required fields: extensionName, toolName, conversationId, invocationId" }, { status: 400 });
  }

  const startTime = Date.now();

  // Phase 3 commit-5: task-tracking is a bundled extension now, so it
  // flows through the ExtensionRegistry path below like every other
  // extension. Ensure wire-on-first-use before the call so the
  // extension's conversation-scoped storage + event subscriptions are
  // reachable without a per-streamChat wiring loop in the executor.
  if (extensionName === "task-tracking") {
    try {
      await ensureTaskTrackingWired(conversationId);
    } catch (wireErr) {
      return json({
        success: false,
        error: `task-tracking wiring failed: ${wireErr instanceof Error ? wireErr.message : String(wireErr)}`,
        retryCount: 0,
        durationMs: Date.now() - startTime,
        toolCallId: invocationId,
      }, { status: 500 });
    }
  }

  // Extension tools — look up in ExtensionRegistry.
  // Namespace separator is `__` (not `.`) because Anthropic's tool-name
  // pattern `^[a-zA-Z0-9_-]+$` rejects dots when tools are sent to the LLM.
  const registry = ExtensionRegistry.getInstance();
  const namespacedTool = `${extensionName}__${toolName}`;

  // Validate tool exists — reload registry if not found (extension may have been re-enabled)
  let registered = registry.getRegisteredTool(namespacedTool);
  if (!registered) {
    await registry.loadFromDb();
    registered = registry.getRegisteredTool(namespacedTool);
    if (!registered) {
      return json({ success: false, error: `Tool not found: ${namespacedTool}` }, { status: 404 });
    }
  }

  const toolExecutor = new ToolExecutor(registry, { bus: getBus() });
  const metadata = { invocationId, source: 'inline' as const };
  let lastResult = { content: [{ type: "text" as const, text: "Unknown error" }], isError: true };
  let retryCount = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await toolExecutor.executeToolCall(
        namespacedTool, input ?? {}, conversationId, messageId ?? null,
        { metadata },
      );

      if (!result.isError) {
        return json({
          success: true,
          output: result.content.map(c => c.text).join("\n"),
          retryCount: attempt,
          durationMs: Date.now() - startTime,
          toolCallId: invocationId,
        });
      }

      lastResult = result;
      retryCount = attempt;
    } catch (err) {
      // Retry on process/registry errors (extension may have crashed and needs restart)
      if (attempt < MAX_RETRIES) {
        continue;
      }
      return json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
        retryCount: attempt,
        durationMs: Date.now() - startTime,
        toolCallId: invocationId,
      }, { status: 500 });
    }
  }

  return json({
    success: false,
    error: lastResult.content.map(c => c.text).join("\n"),
    retryCount,
    durationMs: Date.now() - startTime,
    toolCallId: invocationId,
  });
};
