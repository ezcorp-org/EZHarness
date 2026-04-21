// ── registerEventHandler — Phase 2c SDK wrapper ─────────────────────
//
// Type-safe entry point for extensions that declare
// `permissions.eventSubscriptions`. The host
// (`src/extensions/event-subscription-dispatcher.ts`) sends
// JSON-RPC notifications with method `ezcorp/event/<eventType>` to
// every wired subscriber; this helper registers the handler on the
// shared `HostChannel.onRequest` map.
//
// Surface is a single function — NOT a class — because the
// subscription model is manifest-only. A class-shaped API would imply
// dynamic subscribe/unsubscribe, which the design phase froze as out
// of scope. If you want conditional behavior, filter inside your
// handler.
//
// Example:
//   import { registerEventHandler } from "@ezcorp/sdk/runtime";
//
//   registerEventHandler("task:snapshot", async (payload) => {
//     // payload.conversationId is the host-forced conversation id
//     console.log("snapshot for", payload.conversationId);
//   });

import { getChannel } from "./channel";
import type { SubscribableEvent, SubscribableEventMap } from "./host-event-types";

export type { SubscribableEvent, SubscribableEventMap } from "./host-event-types";

/**
 * Register a handler for a server→extension bus event. The host only
 * delivers events for conversations this extension is wired to, so
 * handlers never need to re-check scope.
 *
 * Multiple calls for the same event type overwrite the previous
 * registration (consistent with HostChannel's `onRequest` Map). A
 * future phase may introduce additive registration; 2c explicitly
 * does not.
 */
export function registerEventHandler<E extends SubscribableEvent>(
  event: E,
  handler: (payload: SubscribableEventMap[E]) => Promise<void> | void,
): void {
  getChannel().onRequest(
    `ezcorp/event/${event}`,
    async (params: unknown) => {
      await handler(params as SubscribableEventMap[E]);
      // onRequest handlers are called for both id-bearing requests AND
      // no-id notifications; only the former get a response written
      // back. Return `undefined` so the id-bearing path gets an empty
      // result (defensive — the host always sends notifications, but
      // returning nothing is still correct).
      return undefined;
    },
  );
}
