/**
 * POST /api/ez-actions/[name]
 *
 * Dispatch endpoint for EZ Actions (`![EZ:name]` runtime sigil).
 * Resolves `[name]` against the in-memory registry, verifies the
 * caller owns the conversation, runs the handler, and persists the
 * result as a synthetic `messages` row with `role: "ez-action-result"`
 * (JSON-encoded `EzActionResult` payload in `content`).
 *
 * Auth: `requireAuth + requireScope("read")` — same pattern as
 * `/api/lessons` (the EZ Actions auth surface mirrors lessons because
 * the v1 set of actions all read or write user-scoped resources). The
 * conversation ownership check is the second gate; we collapse "not
 * found" + "not owned" into 404 per the project's id-enumeration
 * defense pattern.
 *
 * Request body:
 *   { conversationId: string, projectId: string }
 *
 * Response (200):
 *   { result: EzActionResult, messageId: string }
 *
 * Notes on body validation: we accept whatever projectId the client
 * sends but RECONCILE it against the conversation's actual projectId
 * server-side. The handler ALWAYS uses the conversation's projectId
 * — never the body's — so a mismatched/manipulated client payload
 * cannot misdirect the action to a different project.
 */
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getConversation, createMessage, getLatestLeaf } from "$server/db/queries/conversations";
import { getEzAction } from "$server/runtime/ez-actions/registry";
import { resolveBundledEzAction } from "$server/runtime/ez-actions/resolve-bundled";
import type { EzActionResult } from "$server/runtime/ez-actions/types";
import type { RequestHandler } from "./$types";
import { ensureInitialized, getBus } from "$lib/server/context";
import { ExtensionRegistry } from "$server/extensions/registry";
import { ToolExecutor } from "$server/extensions/tool-executor";
import { getPermissionEngine } from "$server/extensions/permission-engine";

/**
 * v1.4 — generic `!EZ:<extName>:<tool>` forwarder.
 *
 * Generalises the v1.3 `forwardDistillToBundled` shim so any bundled
 * extension's tools can be invoked from chat. The dispatch flow is
 * unchanged from the distill case: registry lookup → executeToolCall
 * → result-card mapping. The only branching point is the result
 * mapping:
 *
 *   - `lessons-distiller:distill_now` (or its legacy `!EZ:distill`
 *     alias) parses the `__ezDistillerOutcome` envelope and maps to
 *     the rich `EzActionResult` variants the chat UI knows about.
 *     This branch keeps the v1.3 behavior bit-for-bit so persisted
 *     `![EZ:distill]` tokens render identically.
 *   - Every other bundled `<ext>:<tool>` lands on the **minimal
 *     card** mapping: `kind: "success" | "error"` keyed off
 *     `result.isError`, body lifted from the tool's text output.
 *     No generic envelope contract is introduced in v1.4 — that's a
 *     v1.5+ design conversation per the spec.
 *
 * Auth chain stays as-is — the route's `requireAuth +
 * requireScope("read")` + conversation-ownership gate runs BEFORE
 * this forwarder; the per-tool PermissionEngine gate runs INSIDE
 * `executeToolCall`. No new gate is added here.
 */
async function forwardToBundled(
  extensionName: string,
  toolName: string,
  conversationId: string,
  userId: string,
  useDistillerEnvelope: boolean,
): Promise<EzActionResult> {
  const registry = ExtensionRegistry.getInstance();
  const namespacedTool = `${extensionName}__${toolName}`;

  let registered = registry.getRegisteredTool(namespacedTool);
  if (!registered) {
    await registry.loadFromDb();
    registered = registry.getRegisteredTool(namespacedTool);
  }
  if (!registered) {
    // The route's pre-check has already verified the extension is
    // bundled-trusted; a missing namespaced tool here means the
    // extension is bundled but the specific tool isn't registered
    // (typo, install failed mid-flight, etc.). Surface a precise
    // 404-ish error card rather than the legacy "distiller
    // unavailable" string so users can debug `!EZ:foo:nonexistent`
    // typos.
    if (useDistillerEnvelope) {
      return {
        kind: "error",
        card: {
          title: "Distiller unavailable",
          body: "The lessons-distiller extension is not installed. Try restarting the server.",
          variant: "error",
        },
      };
    }
    return {
      kind: "error",
      card: {
        title: `${extensionName} not available`,
        body: `Tool '${toolName}' is not registered on the bundled extension '${extensionName}'. Check the extension is installed and the tool name is correct.`,
        variant: "error",
      },
    };
  }

  // Pass deps so cold-start (this is the first PermissionEngine
  // touch in the boot sequence — no agent has streamed yet) doesn't
  // throw "not initialized". If another path already initialised the
  // singleton, this just rebuilds it with equivalent deps; the
  // factory has no race-sensitive state.
  const engine = getPermissionEngine({
    registry,
    bus: getBus(),
    db: { _token: "ez-action-forward" },
  });
  const executor = new ToolExecutor(registry, engine, { bus: getBus() });
  executor.setCurrentUserId(userId);
  // Phase 53.1 audit-fix: Date.now() collides under burst load (two
  // dispatcher calls in the same ms produce identical sentinels which
  // breaks per-call attribution). randomUUID is the smallest diff that
  // guarantees uniqueness without changing the call signature.
  const messageIdSentinel = `ez-action-${extensionName}-${toolName}-${crypto.randomUUID()}`;

  let result;
  try {
    result = await executor.executeToolCall(
      namespacedTool,
      { conversationId },
      conversationId,
      messageIdSentinel,
    );
  } catch (err) {
    return {
      kind: "error",
      card: {
        title: useDistillerEnvelope ? "Distiller failed" : `${extensionName} failed`,
        body: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        variant: "error",
      },
    };
  }

  const text = result.content.map((c) => c.text).join("");

  if (!useDistillerEnvelope) {
    // v1.4 minimal card mapping for every non-distill bundled tool.
    // No generic envelope contract; the body is the tool's text
    // verbatim (or `(no output)` for empty), and `kind` follows
    // `result.isError`. This is intentionally shallow — wider mapping
    // is a v1.5+ design conversation.
    if (result.isError) {
      return {
        kind: "error",
        card: {
          title: `${extensionName} returned an error`,
          body: text || "(no detail)",
          variant: "error",
        },
      };
    }
    return {
      kind: "success",
      card: {
        title: `${extensionName} ran successfully`,
        body: text || "(no output)",
        variant: "success",
      },
    };
  }

  // Distiller envelope branch (preserves v1.3 behavior for
  // `!EZ:distill` and `!EZ:lessons-distiller:distill_now`).
  let envelope: { __ezDistillerOutcome?: unknown; outcome?: unknown } | null = null;
  try {
    envelope = JSON.parse(text);
  } catch {
    // Fall through — handled below.
  }
  if (!envelope || envelope.__ezDistillerOutcome !== true) {
    return {
      kind: "error",
      card: {
        title: "Distiller failed",
        body: result.isError
          ? `Tool returned error: ${text || "(no detail)"}`
          : "Tool returned an unexpected response shape.",
        variant: "error",
      },
    };
  }

  const outcome = envelope.outcome as
    | { kind: "success"; lesson: { title: string; slug: string } }
    | { kind: "decline"; reason: string; existingSlug?: string; detail?: string }
    | { kind: "error"; reason: string; detail?: string };

  if (outcome.kind === "success") {
    return {
      kind: "success",
      card: {
        title: "Lesson captured",
        body: `${outcome.lesson.title} (slug: ${outcome.lesson.slug})`,
        variant: "success",
      },
      ref: { kind: "lesson", slug: outcome.lesson.slug },
    };
  }

  if (outcome.kind === "decline") {
    switch (outcome.reason) {
      case "empty_conversation":
        return {
          kind: "decline",
          card: {
            title: "Not enough context",
            body: "This conversation has no messages to distill.",
            variant: "info",
          },
        };
      case "llm_empty":
        return {
          kind: "decline",
          card: {
            title: "Distiller declined",
            body: "The model found no reusable insight in the recent messages. Nothing was captured.",
            variant: "info",
          },
        };
      case "llm_malformed":
        return {
          kind: "decline",
          card: {
            title: "Distiller declined",
            body: `The model's response couldn't be parsed: ${outcome.detail ?? "unknown parse error"}`,
            variant: "warning",
          },
        };
      case "slug_collision":
        return {
          kind: "decline",
          card: {
            title: "Already captured",
            body: `A lesson with the slug "${outcome.existingSlug ?? "(unknown)"}" already exists. The previous capture is the authoritative one.`,
            variant: "info",
          },
        };
      case "settings_disabled":
        return {
          kind: "decline",
          card: {
            title: "Distiller is disabled",
            body: "The lessons distiller is turned off in extension settings. Re-enable it on the lessons-distiller extension page.",
            variant: "warning",
          },
        };
      case "trigger_gate_blocked":
        // Manual handler always passes skipTriggerGate=true so this
        // should be unreachable. Surface as error for visibility if it
        // ever fires (mirrors the legacy handler's branch).
        return {
          kind: "error",
          card: {
            title: "Distiller failed",
            body: "Internal error: trigger gate blocked a manual distill request. Please report this bug.",
            variant: "error",
          },
        };
      default:
        return {
          kind: "decline",
          card: {
            title: "Distiller declined",
            body: `Reason: ${outcome.reason}`,
            variant: "info",
          },
        };
    }
  }

  // outcome.kind === "error"
  if (outcome.reason === "llm_error") {
    return {
      kind: "error",
      card: {
        title: "Distiller failed",
        body: `LLM call failed: ${outcome.detail ?? "unknown LLM error"}`,
        variant: "error",
      },
    };
  }
  if (outcome.reason === "db_error") {
    return {
      kind: "error",
      card: {
        title: "Distiller failed",
        body: `Database error: ${outcome.detail ?? "unknown DB error"}`,
        variant: "error",
      },
    };
  }
  return {
    kind: "error",
    card: {
      title: "Distiller failed",
      body: `Internal error: ${outcome.detail ?? outcome.reason}`,
      variant: "error",
    },
  };
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const scopeErr = requireScope(locals, "read");
	if (scopeErr) return scopeErr;
	const user = requireAuth(locals);

	const name = params.name;
	if (!name) return errorJson(400, "Missing action name");

	// v1.4 — generic bundled-extension dispatch. The resolver returns
	// non-null for the legacy `distill` alias AND any
	// `<bundled-ext>:<tool>` shape; everything else falls back to the
	// static `getEzAction()` registry (which today carries only the
	// `distill` metadata stub). Order matters: try the bundled
	// resolver first so `<ext>:<tool>` doesn't collide with a future
	// registry entry that happens to have a colon in its name.
	const bundled = resolveBundledEzAction(name);
	const action = bundled ? null : getEzAction(name);
	if (!bundled && !action) return errorJson(404, "No such EZ action");

	const body = (await request.json().catch(() => null)) as
		| { conversationId?: unknown; projectId?: unknown }
		| null;
	const conversationId =
		typeof body?.conversationId === "string" ? body.conversationId : null;
	if (!conversationId) {
		return errorJson(400, "conversationId is required");
	}

	// Owner gate: collapse "not found" + "not owned" into one 404 so a
	// scanning client can't enumerate conversation ids by status code.
	const conv = await getConversation(conversationId);
	if (!conv) return errorJson(404, "Conversation not found");
	if (conv.userId !== user.id) return errorJson(404, "Conversation not found");

	// Resolve the conversation's current leaf so the synthetic
	// ez-action-result row hangs off the latest message in the branch.
	// Without this, a direct dispatcher invocation produces an orphan
	// row (parent_message_id = null) that can drift in the branched-
	// conversation render path. The submit-time handler in
	// /api/conversations/[id]/messages parents under the just-persisted
	// user message; the dispatcher has no preceding user message, so the
	// branch leaf is the canonical anchor. `null` (empty conversation)
	// is fine — the row simply has no parent.
	const leaf = await getLatestLeaf(conversationId);
	const parentMessageId = leaf?.id;

	// Run the handler. Handlers are expected to return decline / error
	// result cards rather than throw; an uncaught throw is a handler
	// bug. Mirror the submit-time pattern (messages/+server.ts:290): on
	// throw, synthesize an `error` result card so the user STILL sees a
	// card (not a bare HTTP 500). Every action invocation yields a card
	// — that's the contract — so HTTP 5xx is reserved for genuine
	// transport / persistence failures.
	let result: EzActionResult;
	try {
		// v1.4 — when the resolver bound the name to a bundled
		// `<extension>:<tool>` (or the legacy `distill` alias), forward
		// to that tool. Otherwise dispatch through the static EzActions
		// registry (today only the `distill` metadata stub lives there,
		// but future code-defined EZ actions will). The
		// `useDistillerEnvelope` flag preserves v1.3 behavior for
		// lessons-distiller: the distiller's tool returns a
		// `__ezDistillerOutcome` JSON envelope which the forwarder
		// expands into the rich 11-variant `EzActionResult` mapping.
		// Every other bundled tool gets the v1.4 minimal-card mapping.
		if (bundled) {
			await ensureInitialized();
			const useDistillerEnvelope =
				bundled.extensionName === "lessons-distiller" &&
				bundled.toolName === "distill_now";
			result = await forwardToBundled(
				bundled.extensionName,
				bundled.toolName,
				conversationId,
				user.id,
				useDistillerEnvelope,
			);
		} else {
			// Non-null branch — `action` is set when `bundled` is null
			// per the gate above. The non-null assertion keeps the
			// types tight without an extra runtime check.
			result = await action!.handler({
				conversationId,
				userId: user.id,
				// Use the conversation's projectId, NOT the body's. The body
				// projectId is accepted for client-side convenience but we
				// never trust it.
				projectId: conv.projectId,
			});
		}
	} catch (err) {
		result = {
			kind: "error",
			card: {
				title: "Action failed",
				body: `The "${name}" action threw an unexpected error.`,
				variant: "error",
			},
		};
		// We intentionally do NOT bubble (err as Error).message into the
		// card — the submit-time path doesn't either, and exposing
		// internal error text via an unauthenticated chat-renderable
		// row is the kind of leak that lands on a security review. The
		// detail is captured server-side by the request log.
		console.error("[ez-actions] handler threw", { name, error: String(err) });
	}

	// Persist the result as a synthetic message so it's part of
	// conversation history (renders inline; survives reload). We use
	// `role: "ez-action-result"` (free-text role column — no schema
	// migration needed) and JSON-encode the EzActionResult into
	// `content`. The chat renderer special-cases this role.
	const persisted = await createMessage(conversationId, {
		role: "ez-action-result",
		content: JSON.stringify(result),
		parentMessageId,
	});

	return json({ result, messageId: persisted.id });
};
