import type { RequestHandler } from "./$types";
import { getBus } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getConversation } from "$server/db/queries/conversations";
import { shouldDeliverEvent } from "$server/runtime/sse-conversation-filter";

/**
 * Server-Sent Events (SSE) endpoint for the runtime event bus.
 *
 * Replaces the previous dev-only Bun.serve WebSocket fan-out on port 3002
 * and the production svelte-adapter-bun /ws WebSocket handler. SSE is
 * unidirectional (server → client) which matches our usage — the client
 * never sends data back — and avoids the HTTP upgrade path that is
 * broken on Bun's node:http compat layer, making this work identically
 * in dev (vite) and prod (svelte-adapter-bun) across every access
 * topology (localhost, tailscale HTTPS, LAN).
 *
 * Auth: inherits the session-cookie check from hooks.server.ts Handle,
 * which runs on every non-public route including /api/*. No separate
 * devToken is needed.
 *
 * Phase 2a-lite security: events carrying a top-level `conversationId`
 * are filtered per subscriber — see `src/runtime/sse-conversation-filter.ts`.
 * Events without `conversationId` pass through (they carry `runId` which
 * the client resolves). The filter is a defense-in-depth layer: the client
 * already filters cosmetically, but extensions (Phase 2+) can emit bus
 * events via reverse RPC and server-side filtering is the authoritative
 * check.
 */

const BUS_EVENTS = [
  "run:start", "run:status", "run:log", "run:complete", "run:error", "run:cancel",
  "run:token", "run:usage", "run:turn_saved", "run:turn_text_reset",
  "pipeline:start", "pipeline:step", "pipeline:complete", "pipeline:error",
  "tool:start", "tool:complete", "tool:error", "tool:permission_request",
  "agent:spawn", "agent:status", "agent:complete",
  "task:snapshot", "task:assignment_update",
  "orchestrator:human_input", "orchestrator:human_response",
  "ext:state",
] as const;

export const GET: RequestHandler = async ({ locals, url }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const bus = getBus();

  // Subscriber context captured at connect-time. conversationId is an
  // optional scoping hint from the client — the UI passes it when the
  // SSE connection is bound to a specific conversation page. It's used
  // only for cache-key efficiency today; authorization is enforced
  // per-event against the event's claimed conversationId.
  const subscriberConversationId = url.searchParams.get("conversationId") ?? undefined;
  const subscriber = { userId: user.id, conversationId: subscriberConversationId };

  const stream = new ReadableStream({
    start(controller) {
      const unsubs: Array<() => void> = [];

      for (const event of BUS_EVENTS) {
        unsubs.push(
          bus.on(event, (data: unknown) => {
            // Fire-and-forget async delivery check. We cannot await
            // inside a synchronous bus handler without blocking other
            // handlers; schedule the check on a microtask and only
            // enqueue if authorized. Events deliver out of strict
            // handler-registration order but in causal order per-type
            // (microtasks run FIFO), which is what the client expects.
            shouldDeliverEvent(event, data, subscriber, getConversation)
              .then((deliver) => {
                if (!deliver) return;
                try {
                  const payload = JSON.stringify({ type: event, data });
                  controller.enqueue(`data: ${payload}\n\n`);
                } catch {
                  // Encoding error or controller closed — ignore.
                }
              })
              .catch(() => {
                // Should not happen — shouldDeliverEvent catches its own
                // errors and fails open. If it escapes, drop the event
                // rather than crash the stream.
              });
          }),
        );
      }

      // Send a heartbeat every 30s to keep proxies / load balancers from
      // closing the connection due to inactivity.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(": heartbeat\n\n");
        } catch {
          // Stream closed — cleanup will run via cancel().
        }
      }, 30_000);

      // Stash cleanup refs on the controller so cancel() can reach them.
      (controller as unknown as { _ezCleanup: () => void })._ezCleanup = () => {
        for (const unsub of unsubs) unsub();
        clearInterval(heartbeat);
      };
    },
    cancel(controller) {
      (controller as unknown as { _ezCleanup?: () => void })._ezCleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      // Allow the browser to reconnect after 1s if the connection drops.
      "X-Accel-Buffering": "no",
    },
  });
};
