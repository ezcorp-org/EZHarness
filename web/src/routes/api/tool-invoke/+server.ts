import { json } from "@sveltejs/kit";
import { z } from "zod";
import { ExtensionRegistry } from "$server/extensions/registry";
import { ToolExecutor } from "$server/extensions/tool-executor";
import { getPermissionEngine } from "$server/extensions/permission-engine";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { ensureInitialized, getBus } from "$lib/server/context";
import { ensureTaskTrackingWired } from "$server/runtime/task-tracking-host";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import { getExtension } from "$server/db/queries/extensions";
import { canWireExtension } from "$server/auth/extension-wire-authz";
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
  expectedReleaseBinding: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
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
  const { extensionName, toolName, input, conversationId, invocationId, messageId, expectedReleaseBinding } = parsed.data;
  if (!extensionName || !toolName || !conversationId || !invocationId) {
    return json({ success: false, error: "Missing required fields: extensionName, toolName, conversationId, invocationId" }, { status: 400 });
  }

  const startTime = Date.now();

  // ── Ownership. THE conversation gate for this route (sec: F2). ──
  //
  // `requireScope(locals, "extensions")` above is a NO-OP for a cookie
  // session (`locals.apiKeyScopes` is undefined, which `hasRequiredScope`
  // reads as allow-all), so before this check the only thing standing
  // between an authenticated member and `executeToolCall` was `requireAuth`.
  // `conversationId` was accepted verbatim and never checked against the
  // caller — a member could dispatch any registered tool into an ADMIN's
  // conversation, and `ToolExecutor.executeToolCall` does not look at
  // ownership either.
  //
  // Placed BEFORE the task-tracking wire below on purpose: that call
  // MUTATES `conversation_extensions` for the named conversation, so
  // running it first would let an unauthorized caller write to a
  // conversation they cannot otherwise touch.
  //
  // 404 (not 403) matches the ownership posture of every sibling
  // conversation route — missing and not-yours are indistinguishable. The
  // harness contract already documents ownership rejection as a non-2xx
  // (`docs/harness-contract.md`), and the documented flow (wire, then
  // invoke, same principal + same conversation) is unaffected.
  const ownership = await resolveRootConversationForOwnership(conversationId, user);
  if (!ownership) {
    return json({ success: false, error: "Conversation not found" }, { status: 404 });
  }

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

  // ── Per-extension wire authorization (sec: F2). ──
  //
  // The registry map is GLOBAL — `getRegisteredTool` answers for every
  // installed extension regardless of what is wired to this conversation,
  // and `executeToolCall` never consults `conversation_extensions`. MCP
  // tools also carry no `rbacScope`, so the executor's RBAC gate is skipped
  // and the PDP passes on the install-time network grant. That left direct
  // dispatch as a complete bypass of the wire gate: discovery is free
  // (`GET /api/extensions` is read+auth), so naming the tool was enough.
  //
  // Ask the SAME decision the two wiring surfaces ask. A bundled or
  // non-MCP extension is unaffected (rules 1-2 return true without a query),
  // so this costs one PK read on the MCP path and nothing on the hot path.
  //
  // Deliberately NOT a blanket "must be wired" requirement: that would be a
  // wider behaviour change than the finding needs and would break inline
  // tool cards and Hub actions that legitimately dispatch unwired today.
  // Gating on `canWireExtension` is exactly equivalent — a caller who passes
  // it could simply wire the extension first and dispatch anyway — while a
  // caller who fails it can no longer reach the credential by either route.
  const extRow = await getExtension(registered.extensionId);
  if (!extRow || !(await canWireExtension(extRow, {
    user: { id: user.id, role: user.role },
    projectId: ownership.conv.projectId ?? null,
  }))) {
    // Same shape as an unregistered tool: a member must not learn that an
    // admin-installed MCP server by this name exists.
    return json({ success: false, error: `Tool not found: ${namespacedTool}` }, { status: 404 });
  }

  // PDP singleton — pre-initialized by the executor at boot. Pass no
  // deps so a placeholder bus/db here can't lose an init race; the
  // factory throws clearly if the singleton isn't pre-init.
  const engine = getPermissionEngine();
  const toolExecutor = new ToolExecutor(registry, engine, { bus: getBus() });
  // Set the acting user BEFORE executing so user-scoped extension storage
  // resolves to the caller's own bucket. Without this, `resolveScopeId("user",
  // ctx)` sees a null `ctx.userId` and the RPC fails with "User scope
  // unavailable in this context" (src/extensions/storage-handler.ts). Mirrors
  // the EZ-action forwarder (api/ez-actions/[name]/+server.ts), which likewise
  // calls `executor.setCurrentUserId(userId)`. The authenticated caller is the
  // acting user, so storage is keyed to their bucket (no cross-user exposure).
  toolExecutor.setCurrentUserId(user.id);
  const metadata = { invocationId, source: 'inline' as const };
  let lastResult = { content: [{ type: "text" as const, text: "Unknown error" }], isError: true };
  let retryCount = 0;

  for (let attempt = 0; attempt <= (expectedReleaseBinding ? 0 : MAX_RETRIES); attempt++) {
    try {
      const result = await toolExecutor.executeToolCall(
        namespacedTool, input ?? {}, conversationId, messageId ?? null,
        { metadata, ...(expectedReleaseBinding ? { expectedReleaseBinding } : {}) },
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
      // An authorization denial is DETERMINISTIC — retrying it cannot change
      // the answer. Two things went wrong when it fell through to the generic
      // handler below:
      //
      //   1. It was retried MAX_RETRIES times, so ONE denied tool call wrote
      //      THREE `ext:perm:denied` audit rows and counted as three denials
      //      in the /audit stats strip.
      //   2. It surfaced as 500, which reads as "the server broke" to every
      //      client and integrator. It is a refusal, and the refusal is the
      //      correct behaviour — 403 says so.
      //
      // Matched on `name` rather than `instanceof`: the tool-executor module
      // is mocked at the alias boundary in route tests, so the imported class
      // identity is not guaranteed to be the one the throw site used. The
      // constructor sets `name` explicitly (`tool-executor/errors.ts`).
      if (err instanceof Error && err.name === "PermissionDeniedError") {
        return json({
          success: false,
          // Name the extension, not its UUID. The raw message embeds
          // `extensionId`, which is meaningless to whoever reads this.
          error: `Permission denied for tool "${toolName}" from extension "${extensionName}"${
            (err as { reason?: string }).reason ? ` — ${(err as { reason?: string }).reason}` : ""
          }`,
          retryCount: attempt,
          durationMs: Date.now() - startTime,
          toolCallId: invocationId,
        }, { status: 403 });
      }
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
