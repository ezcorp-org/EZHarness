import type { RequestHandler } from "./$types";
import { getBus } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getConversation } from "$server/db/queries/conversations";
import { shouldDeliverEvent } from "$server/runtime/sse-conversation-filter";
import { BUS_EVENTS } from "./bus-events";

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

// The subscribed event list lives in ./bus-events.ts — SvelteKit rejects
// non-handler exports from +server.ts, and tests must be able to import
// the real list to catch events that emit but never reach this pipe.

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

  // Cleanup state lives in this closure — `cancel()` is called with the
  // cancellation reason (per the WHATWG Streams spec), NOT the controller,
  // so we can't stash refs on the controller and read them back. Hoisting
  // them here lets cancel() unsubscribe bus listeners and clear the
  // heartbeat regardless of what the runtime passes.
  const unsubs: Array<() => void> = [];
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  // Encode every SSE frame to bytes up front. Mixing strings and bytes
  // through `controller.enqueue` lets the runtime pick when to coerce,
  // which adds non-trivial flush latency on Bun. A pre-encoded byte
  // payload reaches the socket the moment we enqueue.
  const encoder = new TextEncoder();
  const encodeFrame = (s: string): Uint8Array => encoder.encode(s);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Immediate priming frame. Forces the kernel to commit the TCP
      // data path before any natural event arrives — without this, the
      // first ~30s of idle on the connection let intermediaries (home
      // router NAT, Tailscale relay) drop the flow before our heartbeat
      // gets a chance, which is exactly the "keeps reconnecting" symptom.
      try {
        controller.enqueue(encodeFrame(": connected\n\n"));
      } catch { /* stream closed before we got here — ignore */ }

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
                  controller.enqueue(encodeFrame(`data: ${payload}\n\n`));
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

      // Send a heartbeat every 15s. 30s loses races against many
      // intermediaries that idle-close at exactly 30s (Tailscale relay
      // sessions, home-router conntrack, AWS NLB). 15s keeps the flow
      // alive without measurable bandwidth cost (4 bytes per frame).
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encodeFrame(": heartbeat\n\n"));
        } catch {
          // Stream closed — cleanup will run via cancel().
        }
      }, 15_000);
    },
    cancel() {
      for (const unsub of unsubs) unsub();
      unsubs.length = 0;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // Defeat any compression middleware in the path. SSE depends on
      // immediate per-frame flushes; gzip/brotli buffer until a block
      // boundary, which masquerades as a stalled connection.
      "Content-Encoding": "identity",
      // Allow the browser to reconnect after 1s if the connection drops.
      "X-Accel-Buffering": "no",
    },
  });
};
